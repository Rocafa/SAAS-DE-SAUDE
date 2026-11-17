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

/** Funções que reduzem o erro a nome da classe e código, sem a mensagem (conferidas à mão; ver cada uma). */
const SANITIZADORES: ReadonlySet<string> = new Set(['codigoDoErro']);
/** Sanitizadores locais, só no arquivo onde foram conferidos (resíduo do parecer do #129). */
const SANITIZADORES_POR_ARQUIVO: Readonly<Record<string, ReadonlySet<string>>> = { 'lifecycle/graceful-shutdown.ts': new Set(['describe']) };

/**
 * Palavras que, dentro de um nome composto (`cpfDoPaciente`, `telefone_responsavel`), tornam o nome sensível. Mais
 * curta que SENSIVEL de propósito: 'name' e 'texto' sozinhos aparecem em nomes seguros (`err.name`, `tipos.texto()`).
 */
const PALAVRAS_SENSIVEIS: ReadonlySet<string> = new Set(['cpf', 'cns', 'rg', 'telefone', 'celular', 'phone', 'email', 'senha', 'password', 'token', 'segredo', 'secret', 'nascimento', 'endereco', 'queixa', 'evolucao', 'diagnostico', 'conteudo', 'nome', 'mensagem', 'message', 'stack', 'body', 'corpo', 'payload']);

function nomeComposto(nome: string): boolean {
  return nome
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .some((p) => PALAVRAS_SENSIVEIS.has(p.toLowerCase()));
}

function sensivel(nome: string): boolean {
  return SENSIVEL.test(nome) || nomeComposto(nome);
}

/** Funções que despejam um objeto inteiro (com o que tiver dentro) no log. */
const DESPEJOS: ReadonlySet<string> = new Set(['util.inspect', 'inspect', 'Object.values', 'Object.entries', 'Object.keys', 'String', 'JSON.stringify']);

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

/** O receptor é um logger? (`this.logger`, `deps.logger`, `new Logger(...)`, ou um apelido dele no arquivo.) */
function ehReceptorDeLog(receptor: ts.Expression, apelidos: ReadonlySet<string>, sf: ts.SourceFile): boolean {
  const texto = receptor.getText(sf);
  return /logger$/i.test(texto) || /^new Logger\(/.test(texto) || /Logger$/.test(texto) || (ts.isIdentifier(receptor) && apelidos.has(receptor.text));
}

/** Analisa um arquivo-fonte (exportada para o teste de sanidade com código fictício). */
export function violacoesNoFonte(arquivo: string, fonte: string): Violacao[] {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true);
  const saida: Violacao[] = [];
  const doArquivo = PERMITIDOS_POR_ARQUIVO[arquivo] ?? {};
  const seguras = new Set<string>();
  const sensiveisRenomeadas = new Set<string>();
  const apelidos = new Set<string>();
  const coletar = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const ini = n.initializer.getText(sf);
      if (ts.isIdentifier(n.name) && INICIALIZACAO_SEGURA.test(ini)) seguras.add(n.name.text);
      // Valor sensível copiado para variável local antes do log: `const x = p.nome` deixa `x` sensível.
      const fonte = n.initializer;
      const nomeDaFonte = ts.isPropertyAccessExpression(fonte) ? fonte.name.text : ts.isIdentifier(fonte) ? fonte.text : undefined;
      if (ts.isIdentifier(n.name) && nomeDaFonte && sensivel(nomeDaFonte)) sensiveisRenomeadas.add(n.name.text);
      // Apelido do logger: `const log = this.logger` (R2 do parecer do #129).
      if (ts.isIdentifier(n.name) && (/logger$/i.test(ini) || /^new Logger\(/.test(ini))) apelidos.add(n.name.text);
      // Desestruturação renomeada: `const { cpf: x } = p` deixa `x` sensível.
      if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const original = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : undefined;
          if (original && sensivel(original) && ts.isIdentifier(el.name)) sensiveisRenomeadas.add(el.name.text);
        }
      }
    }
    ts.forEachChild(n, coletar);
  };
  coletar(sf);
  const liberado = (texto: string): boolean => PERMITIDOS[texto] !== undefined || doArquivo[texto] !== undefined || seguras.has(texto);
  const linha = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const reprovar = (n: ts.Node, motivo: string): void => {
    saida.push({ arquivo, linha: linha(n), motivo });
  };

  const conferirArgumento = (arg: ts.Node): void => {
    const visitar = (n: ts.Node): void => {
      if (liberado(n.getText(sf))) return;
      if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) {
        reprovar(n, `objeto espalhado no log: ${n.getText(sf)}`);
        return;
      }
      if (ts.isCallExpression(n) && DESPEJOS.has(n.expression.getText(sf))) {
        // String(err) segue reprovado pela regra do erro inteiro; String de um valor seguro é inofensivo, mas a regra é
        // fechada: serialize só campos conferidos (log de segurança).
        const alvo = n.arguments[0];
        const seguro = n.expression.getText(sf) === 'String' && alvo !== undefined && (liberado(alvo.getText(sf)) || ts.isStringLiteral(alvo) || ts.isNumericLiteral(alvo));
        if (!seguro) {
          reprovar(n, `${n.expression.getText(sf)} no log: serialize só campos fechados (log de segurança)`);
          return;
        }
      }
      if (ts.isElementAccessExpression(n)) {
        const chave = n.argumentExpression;
        if (ts.isStringLiteral(chave) && sensivel(chave.text)) reprovar(n, `campo sensível no log: ${n.getText(sf)}`);
      }
      if (ts.isPropertyAccessExpression(n)) {
        // `err.name` (classe do erro) é seguro em qualquer forma: err instanceof Error ? err.name : typeof err
        if (n.name.text === 'name' && ERRO.test(n.expression.getText(sf))) return;
        // Chamada de método (`tipos.texto()`) é conferida pela lista de permitidos; nome de método não é dado.
        const ehMetodo = ts.isCallExpression(n.parent) && n.parent.expression === n;
        if (!ehMetodo && sensivel(n.name.text)) reprovar(n, `campo sensível no log: ${n.getText(sf)}`);
      } else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const ehChamada = ts.isCallExpression(n.parent) && n.parent.expression === n;
        if (!ehChamada && (sensivel(n.text) || sensiveisRenomeadas.has(n.text))) reprovar(n, `variável sensível no log: ${n.text}`);
        else if (ERRO.test(n.text) && !liberado(n.text)) {
          // O erro inteiro em qualquer forma (`err`, `${err}`, String(err), 'x' + err). Liberado só como
          // `err.name`, `err instanceof Error` e `typeof err`.
          const pai = n.parent;
          const seguro =
            // `err.x`: o acesso a propriedade é conferido acima (`err.message`/`err.stack` reprovam, `err.name`/`err.code` passam).
            (ts.isPropertyAccessExpression(pai) && pai.expression === n) ||
            (ts.isCallExpression(pai) && (SANITIZADORES.has(pai.expression.getText(sf)) || (SANITIZADORES_POR_ARQUIVO[arquivo]?.has(pai.expression.getText(sf)) ?? false))) ||
            (ts.isBinaryExpression(pai) && pai.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && pai.left === n) ||
            ts.isTypeOfExpression(pai);
          if (!seguro) reprovar(n, `erro inteiro no log (${n.text}); use ${n.text}.name`);
        }
      }
      ts.forEachChild(n, visitar);
    };
    visitar(arg);
  };

  const andar = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const alvo = n.expression;
      const texto = alvo.getText(sf);
      if (/^process\.(stdout|stderr)\.write$/.test(texto)) reprovar(n, `${texto} na API: use o Logger`);
      if (ts.isPropertyAccessExpression(alvo) && METODOS.has(alvo.name.text)) {
        if (ts.isIdentifier(alvo.expression) && alvo.expression.text === 'console') reprovar(n, 'console.* na API: use o Logger');
        else if (ehReceptorDeLog(alvo.expression, apelidos, sf)) n.arguments.forEach(conferirArgumento);
      }
      // `logger[metodo](...)`: não dá para conferir estaticamente.
      if (ts.isElementAccessExpression(alvo) && ehReceptorDeLog(alvo.expression, apelidos, sf)) reprovar(n, `chamada dinâmica de log: ${texto}`);
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

  it('R2 do parecer do #129: os 9 furos achados pelo Guardião são reprovados', () => {
    const fonte = [
      'class X {',
      '  f(p: { cpf: string }, err: Error, metodo: string, o: object) {',
      '    const log = this.logger;',
      "    log.warn('x', p.cpf);",
      '    this.logger[metodo]("x");',
      '    this.logger.warn({ ...o });',
      '    this.logger.warn(JSON.stringify(o));',
      '    this.logger.error(String(err));',
      "    this.logger.error('falhou ' + err);",
      "    this.logger.warn(p['cpf']);",
      '    const { cpf: doc } = p;',
      '    this.logger.warn(doc);',
      "    process.stderr.write('x');",
      '  }',
      '}',
    ].join('\n');
    const linhas = violacoesNoFonte('ficticio.ts', fonte).map((v) => v.linha);
    // 4 apelido, 5 dinâmica, 6 spread, 7 JSON.stringify, 8 String(err), 9 concatenação, 10 p['cpf'],
    // 12 desestruturação renomeada, 13 process.stderr.write
    for (const l of [4, 5, 6, 7, 8, 9, 10, 12, 13]) expect(linhas, `linha ${l}`).toContain(l);
  });

  it('resíduos do parecer do #129: cópia para variável local, despejo de objeto, nome composto e describe fora do arquivo', () => {
    const fonte = [
      'class X {',
      '  f(p: { nome: string; cpfDoPaciente: string; nomeDoPaciente: string }, err: Error, o: object) {',
      '    const x = p.nome;',
      '    this.logger.warn(x);',
      '    this.logger.warn(util.inspect(o));',
      '    this.logger.warn(Object.values(o).join());',
      '    this.logger.warn(p.cpfDoPaciente);',
      '    this.logger.warn(p.nomeDoPaciente);',
      '    this.logger.error(describe(err));',
      "    this.logger.warn(String('ok'));",
      '  }',
      '}',
    ].join('\n');
    const linhas = violacoesNoFonte('ficticio.ts', fonte).map((v) => v.linha);
    // 4 cópia local, 5 util.inspect, 6 Object.values, 7 e 8 nome composto (R1 do parecer do #141), 9 describe fora do
    // graceful-shutdown
    for (const l of [4, 5, 6, 7, 8, 9]) expect(linhas, `linha ${l}`).toContain(l);
    expect(linhas).not.toContain(10);
    // describe continua liberado só no arquivo onde foi conferido.
    expect(violacoesNoFonte('lifecycle/graceful-shutdown.ts', 'const f = (err: Error) => logger.error(describe(err));')).toEqual([]);
  });
});
