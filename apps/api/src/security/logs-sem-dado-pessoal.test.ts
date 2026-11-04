/**
 * Trava de PR: nenhum log da API carrega dado pessoal (LGPD arts. 6 III e 46).
 *
 * Lê todo `src` (fora dos testes) com o compilador do TypeScript e, em cada chamada de log
 * (`logger.log/warn/error/debug/verbose/fatal`, `new Logger(...).x`, `console.x`):
 * - reprova `console.*` (o log da API passa pelo Logger, que vai para o CloudWatch);
 * - reprova nomes que costumam carregar dado pessoal ou segredo (nome, cpf, telefone, email, conteúdo, texto,
 *   corpo, mensagem do erro, stack, token, senha…), em identificadores e acessos a propriedade;
 * - reprova passar o erro inteiro (`logger.error(err)` ou `${err}`): a mensagem pode ter dado; use `err.name`.
 * Exceções têm de estar em `PERMITIDOS`, com o motivo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const METODOS = new Set(['log', 'warn', 'error', 'debug', 'verbose', 'fatal']);
const SENSIVEL = /^(nome|name|nomes|displayname|cpf|telefone|phone|celular|email|e_?mail|endereco|address|nascimento|birth|conteudo|content|texto|text|corpo|body|mensagem|message|stack|token|senha|password|segredo|secret|queixa|evolucao|diagnostico|cid|rawbody|payload|headers|cookie|authorization)$/i;
const ERRO = /^(err|e|erro|error|reason|exc|excecao)$/;

/** Expressões liberadas, com o motivo (o texto é o da expressão no código). */
const PERMITIDOS: Readonly<Record<string, string>> = {
  'err.name': 'nome da classe do erro, sem a mensagem',
  'job.name': 'nome do job do agendador (constante do registro)',
  'job?.name': 'nome do job do agendador (constante do registro)',
  'tipos.texto()': 'contagem de tipos de falha do KMS (ex.: throttling:2), sem dado',
};

/** Liberações que só valem num arquivo (nome do job, motivo do desligamento), com o motivo. */
const PERMITIDOS_POR_ARQUIVO: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'modules/jobs/executor-de-jobs.ts': { nome: 'nome do job (constante do registro)', 'job.nome': 'nome do job (constante do registro)' },
  'modules/jobs/sinal-de-vida.ts': { 'j.nome': 'nome do job (constante do registro)' },
  'lifecycle/graceful-shutdown.ts': { reason: 'motivo do desligamento (SIGTERM, SIGINT…), não um erro' },
};

/**
 * Variável local que só guarda a CLASSE do erro ou o código dele (`const name = err instanceof Error ? err.name : …`,
 * `const erro = codigoDoErro(e)`) é segura no log. Reconhecida pela inicialização, não pelo nome.
 */
const INICIALIZACAO_SEGURA = /instanceof Error \? \w+\.name\b|^codigoDoErro\(/;

export interface Violacao {
  readonly arquivo: string;
  readonly linha: number;
  readonly motivo: string;
}

function ehChamadaDeLog(chamada: ts.CallExpression): { console: boolean } | null {
  const alvo = chamada.expression;
  if (!ts.isPropertyAccessExpression(alvo) || !METODOS.has(alvo.name.text)) return null;
  const receptor = alvo.expression;
  if (ts.isIdentifier(receptor) && receptor.text === 'console') return { console: true };
  const texto = receptor.getText();
  if (/logger$/i.test(texto) || /^new Logger\(/.test(texto) || /Logger$/.test(texto)) return { console: false };
  return null;
}

/** Analisa um arquivo-fonte (exportada para o teste de sanidade com código fictício). */
export function violacoesNoFonte(arquivo: string, fonte: string): Violacao[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true);
  const saida: Violacao[] = [];
  const doArquivo = PERMITIDOS_POR_ARQUIVO[arquivo] ?? {};
  const seguras = new Set<string>();
  const coletar = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && INICIALIZACAO_SEGURA.test(n.initializer.getText(sf))) seguras.add(n.name.text);
    ts.forEachChild(n, coletar);
  };
  coletar(sf);
  const liberado = (texto: string): boolean => PERMITIDOS[texto] !== undefined || doArquivo[texto] !== undefined || seguras.has(texto);
  const linha = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const conferirArgumento = (arg: ts.Node): void => {
    // Erro inteiro como argumento ou interpolação.
    const direto = ts.isTemplateExpression(arg) ? arg.templateSpans.map((s) => s.expression) : [arg];
    for (const d of direto) {
      if (ts.isIdentifier(d) && ERRO.test(d.text) && !liberado(d.text)) saida.push({ arquivo, linha: linha(d), motivo: `erro inteiro no log (${d.text}); use ${d.text}.name` });
    }
    const visitar = (n: ts.Node): void => {
      if (liberado(n.getText(sf))) return;
      if (ts.isPropertyAccessExpression(n)) {
        const objeto = n.expression.getText(sf);
        // `err.name` (classe do erro) é seguro em qualquer forma: err instanceof Error ? err.name : typeof err
        if (n.name.text === 'name' && ERRO.test(objeto)) return;
        if (SENSIVEL.test(n.name.text)) saida.push({ arquivo, linha: linha(n), motivo: `campo sensível no log: ${n.getText(sf)}` });
      } else if (ts.isIdentifier(n) && SENSIVEL.test(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        saida.push({ arquivo, linha: linha(n), motivo: `variável sensível no log: ${n.text}` });
      }
      ts.forEachChild(n, visitar);
    };
    visitar(arg);
  };
  const andar = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const log = ehChamadaDeLog(n);
      if (log?.console) saida.push({ arquivo, linha: linha(n), motivo: 'console.* na API: use o Logger' });
      else if (log) n.arguments.forEach(conferirArgumento);
    }
    ts.forEachChild(n, andar);
  };
  andar(sf);
  return saida;
}

function arquivosDaApi(raiz: string): string[] {
  const out: string[] = [];
  const ir = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) ir(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
  };
  ir(raiz);
  return out;
}

describe('logs sem dado pessoal (trava de PR)', () => {
  it('nenhuma chamada de log em src usa dado pessoal, segredo, erro inteiro ou console', () => {
    const raiz = join(__dirname, '..');
    const violacoes = arquivosDaApi(raiz).flatMap((p) => violacoesNoFonte(relative(raiz, p).replace(/\\/g, '/'), readFileSync(p, 'utf8')));
    expect(violacoes.map((v) => `${v.arquivo}:${v.linha} ${v.motivo}`)).toEqual([]);
  });

  it('a trava encontra arquivos de log de verdade (não passa vazia)', () => {
    const raiz = join(__dirname, '..');
    const comLog = arquivosDaApi(raiz).filter((p) => /logger\.(warn|error)\(/.test(readFileSync(p, 'utf8')));
    expect(comLog.length).toBeGreaterThan(10);
  });

  it('sanidade: código fictício com dado pessoal é reprovado', () => {
    const fonte = [
      'class X {',
      '  f(paciente: { nome: string; cpf: string }, err: Error, corpo: string) {',
      '    this.logger.warn(`paciente ${paciente.nome}`);',
      '    this.logger.error(`cpf=${paciente.cpf}`);',
      '    this.logger.error(err);',
      '    this.logger.error(`falhou: ${err.message}`);',
      '    this.logger.log(corpo);',
      "    console.log('x');",
      '    this.logger.error(`ok ${err instanceof Error ? err.name : typeof err}`);',
      '  }',
      '}',
    ].join('\n');
    const motivos = violacoesNoFonte('ficticio.ts', fonte).map((v) => `${v.linha}:${v.motivo}`);
    expect(motivos).toEqual([
      '3:campo sensível no log: paciente.nome',
      '4:campo sensível no log: paciente.cpf',
      '5:erro inteiro no log (err); use err.name',
      '6:campo sensível no log: err.message',
      '7:variável sensível no log: corpo',
      '8:console.* na API: use o Logger',
    ]);
  });
});
