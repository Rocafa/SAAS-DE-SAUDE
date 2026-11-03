/**
 * Análise estática da cobertura de auditoria (#105, S6): lista toda rota de escrita da API e diz se existe caminho
 * de chamada do handler até a gravação da trilha: `insertAudit` de `src/modules/audit/audit-log.ts`, por onde passam
 * `recordAudit` (sessão da clínica), `recordSupportAudit` (suporte) e a auditoria do portal do paciente.
 *
 * Usa o compilador do TypeScript (o mesmo `tsconfig` da API): as rotas saem dos decorators `@Controller` e
 * `@Post/@Patch/@Put/@Delete`, e as chamadas são resolvidas pelo verificador de tipos, atravessando serviços,
 * funções importadas e callbacks (como o corpo de `escreverNaClinica`). Só segue código de `src/`.
 *
 * Limite conhecido: prova que EXISTE um caminho até a trilha, não que todo ramo do handler grava. Por isso a lista
 * de declaração (lista.ts, ao lado) é revisada pelo Guardião, e o teste RLS de cada módulo confere a
 * linha gravada nos casos principais.
 */
import * as path from 'node:path';
import ts from 'typescript';

export const METODOS_DE_ESCRITA = ['Post', 'Patch', 'Put', 'Delete'] as const;
/** A função que grava a linha da trilha. Alcançá-la a partir do handler conta como auditado. */
export const GRAVADOR_DA_TRILHA = { nome: 'insertAudit', arquivo: 'src/modules/audit/audit-log.ts' } as const;

export interface RotaDeEscrita {
  /** `POST /pacientes/:id/responsaveis`, normalizado (sem barra dupla nem final). */
  readonly rota: string;
  /** `PatientsController.criar`. */
  readonly handler: string;
  /** `src/modules/patients/patients.controller.ts`. */
  readonly arquivo: string;
  /** Existe caminho de chamada do handler até um gravador da trilha. */
  readonly alcancaTrilha: boolean;
}

const RAIZ_API = path.resolve(__dirname, '../..');
const RAIZ_SRC = path.join(RAIZ_API, 'src');

function criarPrograma(): ts.Program {
  const arquivoConfig = path.join(RAIZ_API, 'tsconfig.json');
  const lido = ts.readConfigFile(arquivoConfig, (f) => ts.sys.readFile(f));
  if (lido.error) throw new Error(ts.flattenDiagnosticMessageText(lido.error.messageText, '\n'));
  const cfg = ts.parseJsonConfigFileContent(lido.config, ts.sys, RAIZ_API);
  const raizes = cfg.fileNames.filter((f) => path.resolve(f).startsWith(RAIZ_SRC) && !/\.test\.ts$/.test(f));
  return ts.createProgram(raizes, { ...cfg.options, noEmit: true });
}

function argumentoTexto(dec: ts.Decorator): string | undefined {
  if (!ts.isCallExpression(dec.expression)) return undefined;
  const [a] = dec.expression.arguments;
  if (a === undefined) return '';
  if (ts.isStringLiteralLike(a)) return a.text;
  throw new Error(`rota com caminho não literal: ${dec.getText()} (${dec.getSourceFile().fileName})`);
}

function nomeDoDecorator(dec: ts.Decorator): string | undefined {
  const e = dec.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  return undefined;
}

function juntar(...partes: string[]): string {
  const p = partes
    .flatMap((x) => x.split('/'))
    .filter((x) => x.length > 0)
    .join('/');
  return `/${p}`;
}

function relativo(decl: ts.Node): string {
  return path.relative(RAIZ_API, decl.getSourceFile().fileName).split(path.sep).join('/');
}

function dentroDoSrc(decl: ts.Node): boolean {
  return path.resolve(decl.getSourceFile().fileName).startsWith(RAIZ_SRC);
}

/** Declaração da função/método chamado, quando é código nosso com corpo. */
function alvoDaChamada(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): ts.Node | undefined {
  const assinatura = checker.getResolvedSignature(call);
  let decl: ts.Node | undefined = assinatura?.getDeclaration();
  if (!decl) {
    const simbolo = checker.getSymbolAtLocation(ts.isCallExpression(call) ? call.expression : call.expression);
    decl = simbolo?.declarations?.[0];
  }
  return decl;
}

function nomeDaDeclaracao(decl: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) && decl.name && ts.isIdentifier(decl.name)) return decl.name.text;
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
  return undefined;
}

function corpoDe(decl: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isConstructorDeclaration(decl)) return decl.body;
  if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
    return decl.initializer.body;
  }
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return decl.body;
  return undefined;
}

/**
 * Busca em profundidade: algum caminho de chamadas a partir de `corpo` chega ao gravador da trilha? `alcancam` guarda
 * só os corpos que CHEGAM (resultado positivo vale para qualquer rota); um negativo pode ser parcial quando há ciclo,
 * então não é reaproveitado entre rotas (cada rota tem o próprio conjunto de visitados).
 */
function alcanca(checker: ts.TypeChecker, inicio: ts.Node, alcancam: Set<ts.Node>): boolean {
  const visitados = new Set<ts.Node>();
  const busca = (corpo: ts.Node): boolean => {
    if (alcancam.has(corpo)) return true;
    if (visitados.has(corpo)) return false;
    visitados.add(corpo);
    let achou = false;
    const andar = (n: ts.Node): void => {
      if (achou) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const decl = alvoDaChamada(checker, n);
        if (decl) {
          const nome = nomeDaDeclaracao(decl);
          if (nome === GRAVADOR_DA_TRILHA.nome && relativo(decl) === GRAVADOR_DA_TRILHA.arquivo) {
            achou = true;
            return;
          }
          const c = dentroDoSrc(decl) ? corpoDe(decl) : undefined;
          if (c && busca(c)) {
            achou = true;
            return;
          }
        }
      }
      ts.forEachChild(n, andar);
    };
    andar(corpo);
    if (achou) alcancam.add(corpo);
    return achou;
  };
  return busca(inicio);
}

/** Todas as rotas de escrita da API, com a resposta da análise de alcance. Ordenadas pela rota. */
export function analisarRotasDeEscrita(): RotaDeEscrita[] {
  const programa = criarPrograma();
  const checker = programa.getTypeChecker();
  // Código com erro de sintaxe daria análise parcial (e falso "não audita"): melhor falhar com o motivo.
  const sintaxe = programa.getSyntacticDiagnostics();
  if (sintaxe.length > 0) {
    const [d] = sintaxe;
    throw new Error(`erro de sintaxe em ${d?.file?.fileName ?? '?'}: ${ts.flattenDiagnosticMessageText(d?.messageText ?? '', ' ')}`);
  }
  const alcancam = new Set<ts.Node>();
  const rotas: RotaDeEscrita[] = [];
  for (const sf of programa.getSourceFiles()) {
    if (!path.resolve(sf.fileName).startsWith(RAIZ_SRC)) continue;
    const visitar = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name) {
        const decs = ts.getDecorators(n) ?? [];
        const ctrl = decs.find((d) => nomeDoDecorator(d) === 'Controller');
        if (ctrl) {
          const base = argumentoTexto(ctrl) ?? '';
          for (const membro of n.members) {
            if (!ts.isMethodDeclaration(membro) || !membro.body) continue;
            for (const d of ts.getDecorators(membro) ?? []) {
              const metodo = nomeDoDecorator(d);
              if (!metodo || !(METODOS_DE_ESCRITA as readonly string[]).includes(metodo)) continue;
              const sub = argumentoTexto(d) ?? '';
              rotas.push({
                rota: `${metodo.toUpperCase()} ${juntar(base, sub)}`,
                handler: `${n.name.text}.${membro.name.getText()}`,
                arquivo: relativo(sf),
                alcancaTrilha: alcanca(checker, membro.body, alcancam),
              });
            }
          }
        }
      }
      ts.forEachChild(n, visitar);
    };
    visitar(sf);
  }
  return rotas.sort((a, b) => a.rota.localeCompare(b.rota));
}
