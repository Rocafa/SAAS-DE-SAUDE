/**
 * Análise estática da cobertura de auditoria (#105, S6): lista toda rota de escrita da API e diz se existe caminho
 * de chamada do handler até a gravação da trilha: `insertAudit` de `src/modules/audit/audit-log.ts`, por onde passam
 * `recordAudit` (sessão da clínica), `recordSupportAudit` (suporte) e a auditoria do portal do paciente.
 *
 * Usa o compilador do TypeScript (o mesmo `tsconfig` da API). As rotas saem dos decorators de `@nestjs/common`,
 * resolvidos pelo SÍMBOLO (um `import { Post as P }` é visto; decorator HTTP desconhecido ou composto falha alto, R3
 * do parecer de 03/11). As chamadas são resolvidas pelo verificador de tipos, atravessando serviços, funções
 * importadas e callbacks (como o corpo de `escreverNaClinica`). Só segue o nosso código.
 *
 * Gravadores INCIDENTAIS (gravam só na negação de acesso ou na anomalia) não contam e não são atravessados (R1): sem
 * isso, toda rota nova do prontuário e do portal "alcançaria a trilha" sem gravar a própria ação.
 *
 * Limite conhecido: prova que EXISTE um caminho até a trilha, não que todo ramo do handler grava. Por isso a lista
 * de declaração (lista.ts, ao lado) é revisada pelo Guardião, e o teste RLS de cada módulo confere a linha gravada
 * nos casos principais.
 */
import * as path from 'node:path';
import ts from 'typescript';

/** Decorators HTTP de `@nestjs/common` tratados como escrita. */
export const METODOS_DE_ESCRITA = ['Post', 'Patch', 'Put', 'Delete', 'All'] as const;
/** Decorators HTTP de `@nestjs/common` tratados como leitura (R5 do parecer de 03/11). */
export const METODOS_DE_LEITURA = ['Get'] as const;
/** Qualquer outro decorator de rota do Nest: a análise falha com o nome, até alguém decidir como tratá-lo. */
const METODOS_NAO_TRATADOS = ['Options', 'Head', 'Search', 'RequestMapping', 'applyDecorators'] as const;

/** A função que grava a linha da trilha. Alcançá-la a partir do handler conta como auditado. */
export const GRAVADOR_DA_TRILHA = { nome: 'insertAudit', arquivo: 'src/modules/audit/audit-log.ts' } as const;

/**
 * Gravadores incidentais: não contam como trilha da rota e a busca não desce no corpo deles (os argumentos, como o
 * callback `operacao` de `comNegacaoAuditada`, continuam sendo seguidos). Gravador incidental novo entra aqui com
 * parecer do Guardião.
 */
export const GRAVADORES_INCIDENTAIS: readonly { readonly nome: string; readonly arquivo: string; readonly motivo: string }[] = [
  { nome: 'comNegacaoAuditada', arquivo: 'src/modules/records/acesso-clinico.ts', motivo: 'grava só a negação de acesso clínico (catch)' },
  { nome: 'alertar', arquivo: 'src/modules/patients/vigilancia-de-leitura.ts', motivo: 'grava só a anomalia de leitura, em transação própria' },
  { nome: 'alertar', arquivo: 'src/modules/portal/portal-vigilancia.ts', motivo: 'grava só a anomalia do portal, em transação própria' },
];

export interface RotaAnalisada {
  /** `POST /pacientes/:id/responsaveis`, normalizado (sem barra dupla nem final). */
  readonly rota: string;
  /** `PatientsController.criar`. */
  readonly handler: string;
  /** `src/modules/patients/patients.controller.ts`. */
  readonly arquivo: string;
  /** Existe caminho de chamada do handler até o gravador da trilha (sem passar por gravador incidental). */
  readonly alcancaTrilha: boolean;
  /** O corpo do handler só lança erro (R2: prova da exceção `sem_efeito`). */
  readonly soLanca: boolean;
  /** Textos dos templates `sql\`...\`` alcançados a partir do handler (R4: prova da exceção `banco`). Só é
   * calculado para rota que não alcança a trilha (as exceções); nas outras fica vazio. */
  readonly sqlAlcancado: readonly string[];
  /** Decorators NOSSOS da rota (do método e da classe), pelo nome original; ex.: `ExigeMfaRecente` (R4 do #123). */
  readonly marcas: readonly string[];
}

const RAIZ_API = path.resolve(__dirname, '../..');
const RAIZ_SRC = path.join(RAIZ_API, 'src');

function relativo(n: ts.Node): string {
  const sf = ts.isSourceFile(n) ? n : n.getSourceFile();
  return path.relative(RAIZ_API, sf.fileName).split(path.sep).join('/');
}

function criarPrograma(extras: readonly string[]): ts.Program {
  const arquivoConfig = path.join(RAIZ_API, 'tsconfig.json');
  const lido = ts.readConfigFile(arquivoConfig, (f) => ts.sys.readFile(f));
  if (lido.error) throw new Error(ts.flattenDiagnosticMessageText(lido.error.messageText, ' '));
  const cfg = ts.parseJsonConfigFileContent(lido.config, ts.sys, RAIZ_API);
  const raizes = cfg.fileNames.filter((f) => path.resolve(f).startsWith(RAIZ_SRC) && !/\.test\.ts$/.test(f));
  return ts.createProgram([...raizes, ...extras], { ...cfg.options, noEmit: true });
}

interface Contexto {
  readonly checker: ts.TypeChecker;
  /** O "nosso código": src/ e os arquivos extras (fixtures do teste). */
  readonly nosso: (n: ts.Node) => boolean;
  /**
   * Implementações de um método de INTERFACE (porta): `provider.escolherClinica()` chamado pela interface segue
   * para o método de mesmo nome em toda classe nossa que declara `implements` dessa interface.
   */
  readonly implementacoes: (metodo: ts.Node) => ts.Node[];
}

function falhar(n: ts.Node, msg: string): never {
  const sf = n.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
  throw new Error(`${msg} (${relativo(sf)}:${line + 1})`);
}

function argumentoTexto(dec: ts.Decorator): string {
  if (!ts.isCallExpression(dec.expression)) return '';
  const [a] = dec.expression.arguments;
  if (a === undefined) return '';
  if (ts.isStringLiteralLike(a)) return a.text;
  return falhar(dec, `rota com caminho não literal: ${dec.getText()}`);
}

/** Nome original e origem de um decorator, pelo símbolo (segue alias de import). */
function identidadeDoDecorator(cx: Contexto, dec: ts.Decorator): { nome: string; doNest: boolean; decl: ts.Declaration | undefined } | undefined {
  const e = ts.isCallExpression(dec.expression) ? dec.expression.expression : dec.expression;
  let simbolo = cx.checker.getSymbolAtLocation(e);
  if (!simbolo) return undefined;
  if (simbolo.flags & ts.SymbolFlags.Alias) simbolo = cx.checker.getAliasedSymbol(simbolo);
  const decl = simbolo.declarations?.[0];
  const arquivo = decl?.getSourceFile().fileName.split(path.sep).join('/') ?? '';
  return { nome: simbolo.getName(), doNest: arquivo.includes('/@nestjs/common/'), decl };
}

const RE_ROTA_COMPOSTA = /\bapplyDecorators\b|\bRequestMapping\b|\b(Get|Post|Put|Patch|Delete|All|Options|Head|Search)\s*\(/;

/** Decorator de método de controller: o verbo HTTP do tipo pedido, `null` (não é rota desse tipo) ou falha alto. */
function verboDaRota(cx: Contexto, dec: ts.Decorator, tipo: TipoDeRota): string | null {
  const id = identidadeDoDecorator(cx, dec);
  if (!id) return null;
  if (id.doNest) {
    const metodos: readonly string[] = tipo === 'escrita' ? METODOS_DE_ESCRITA : METODOS_DE_LEITURA;
    if (metodos.includes(id.nome)) return id.nome;
    if ((METODOS_NAO_TRATADOS as readonly string[]).includes(id.nome)) return falhar(dec, `decorator de rota não tratado pela análise de auditoria: @${id.nome}`);
    return null;
  }
  // Decorator nosso que monta rota por dentro (applyDecorators, Post(...)): a análise não o enxerga, então falha.
  if (id.decl && cx.nosso(id.decl) && RE_ROTA_COMPOSTA.test(id.decl.getText())) {
    return falhar(dec, `decorator composto de rota não tratado pela análise de auditoria: @${id.nome}`);
  }
  return null;
}

function ehControllerDoNest(cx: Contexto, dec: ts.Decorator): boolean {
  const id = identidadeDoDecorator(cx, dec);
  return id?.doNest === true && id.nome === 'Controller';
}

function juntar(...partes: string[]): string {
  const p = partes
    .flatMap((x) => x.split('/'))
    .filter((x) => x.length > 0)
    .join('/');
  return `/${p}`;
}

/** Declaração da função/método chamado. */
function alvoDaChamada(cx: Contexto, call: ts.CallExpression | ts.NewExpression): ts.Node | undefined {
  const decl: ts.Node | undefined = cx.checker.getResolvedSignature(call)?.getDeclaration();
  return decl ?? cx.checker.getSymbolAtLocation(call.expression)?.declarations?.[0];
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

function ehGravador(decl: ts.Node): boolean {
  return nomeDaDeclaracao(decl) === GRAVADOR_DA_TRILHA.nome && relativo(decl) === GRAVADOR_DA_TRILHA.arquivo;
}

function ehIncidental(decl: ts.Node): boolean {
  const nome = nomeDaDeclaracao(decl);
  const arq = relativo(decl);
  return GRAVADORES_INCIDENTAIS.some((g) => g.nome === nome && g.arquivo === arq);
}

/**
 * Percorre o grafo de chamadas a partir de `inicio` (sem descer em gravador incidental), chamando `visitar` em cada
 * nó. `visitar` devolve `true` para parar. Devolve se parou.
 */
function percorrer(cx: Contexto, inicio: ts.Node, visitar: (n: ts.Node, alvo?: ts.Node) => boolean): boolean {
  const visitados = new Set<ts.Node>();
  let parou = false;
  const busca = (corpo: ts.Node): void => {
    if (parou || visitados.has(corpo)) return;
    visitados.add(corpo);
    const andar = (n: ts.Node): void => {
      if (parou) return;
      let alvo: ts.Node | undefined;
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) alvo = alvoDaChamada(cx, n);
      if (visitar(n, alvo)) {
        parou = true;
        return;
      }
      if (alvo && cx.nosso(alvo) && !ehIncidental(alvo)) {
        const c = corpoDe(alvo);
        if (c) busca(c);
        if (parou) return;
        for (const impl of cx.implementacoes(alvo)) {
          const ci = corpoDe(impl);
          if (ci) busca(ci);
          if (parou) return;
        }
      }
      ts.forEachChild(n, andar);
    };
    andar(corpo);
  };
  busca(inicio);
  return parou;
}

function soLanca(corpo: ts.Block): boolean {
  return corpo.statements.length > 0 && corpo.statements.every((s) => ts.isThrowStatement(s));
}

function sqlAlcancado(cx: Contexto, inicio: ts.Node): string[] {
  const textos: string[] = [];
  percorrer(cx, inicio, (n) => {
    if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === 'sql') textos.push(n.template.getText());
    return false;
  });
  return textos;
}

export type TipoDeRota = 'escrita' | 'leitura';

/** Rotas de escrita (`POST/PATCH/PUT/DELETE/ALL`), com a análise de alcance. */
export function analisarRotasDeEscrita(extras: readonly string[] = []): RotaAnalisada[] {
  return analisarRotas('escrita', extras);
}

/** Rotas de leitura (`GET`), com a análise de alcance (R5 do parecer de 03/11). */
export function analisarRotasDeLeitura(extras: readonly string[] = []): RotaAnalisada[] {
  return analisarRotas('leitura', extras);
}

/**
 * Rotas da API do tipo pedido (ordenadas pela rota), com a análise de alcance. `extras`: arquivos fora de `src/`
 * tratados como nosso código e cujas rotas são as ÚNICAS devolvidas (fixtures de sanidade do teste).
 */
function analisarRotas(tipo: TipoDeRota, extras: readonly string[]): RotaAnalisada[] {
  const absolutos = extras.map((f) => path.resolve(f));
  const programa = criarPrograma(absolutos);
  // Código com erro de sintaxe daria análise parcial (e falso "não audita"): melhor falhar com o motivo.
  const [erro] = programa.getSyntacticDiagnostics();
  if (erro) throw new Error(`erro de sintaxe em ${erro.file?.fileName ?? '?'}: ${ts.flattenDiagnosticMessageText(erro.messageText, ' ')}`);
  const doExtra = (f: string) => absolutos.includes(path.resolve(f));
  const nosso = (n: ts.Node): boolean => {
    const f = path.resolve(n.getSourceFile().fileName);
    return f.startsWith(RAIZ_SRC) || doExtra(f);
  };
  // Classes nossas por interface implementada (nome da interface → classes).
  const porInterface = new Map<string, ts.ClassDeclaration[]>();
  for (const sf of programa.getSourceFiles()) {
    if (!nosso(sf)) continue;
    const ver = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n)) {
        for (const h of n.heritageClauses ?? []) {
          if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const t of h.types) {
            const nome = t.expression.getText(sf);
            porInterface.set(nome, [...(porInterface.get(nome) ?? []), n]);
          }
        }
      }
      ts.forEachChild(n, ver);
    };
    ver(sf);
  }
  const cx: Contexto = {
    checker: programa.getTypeChecker(),
    nosso,
    implementacoes: (metodo) => {
      if (!ts.isMethodSignature(metodo) || !ts.isInterfaceDeclaration(metodo.parent) || !ts.isIdentifier(metodo.name)) return [];
      const nome = metodo.name.text;
      return (porInterface.get(metodo.parent.name.text) ?? []).flatMap((c) =>
        c.members.filter((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === nome),
      );
    },
  };
  const rotas: RotaAnalisada[] = [];
  for (const sf of programa.getSourceFiles()) {
    const f = path.resolve(sf.fileName);
    if (absolutos.length > 0 ? !doExtra(f) : !f.startsWith(RAIZ_SRC)) continue;
    const visitar = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name) {
        const ctrl = (ts.getDecorators(n) ?? []).find((d) => ehControllerDoNest(cx, d));
        if (ctrl) {
          const base = argumentoTexto(ctrl);
          const marcasDe = (decs: readonly ts.Decorator[]) =>
            decs.map((x) => identidadeDoDecorator(cx, x)).filter((x) => x !== undefined && !x.doNest).map((x) => (x as { nome: string }).nome);
          const marcasDaClasse = marcasDe(ts.getDecorators(n) ?? []);
          for (const membro of n.members) {
            if (!ts.isMethodDeclaration(membro)) continue;
            for (const d of ts.getDecorators(membro) ?? []) {
              const verbo = verboDaRota(cx, d, tipo);
              if (!verbo) continue;
              if (!membro.body) falhar(membro, 'rota sem corpo');
              const corpo = membro.body;
              const alcancaTrilha = percorrer(cx, corpo, (_n, alvo) => alvo !== undefined && ehGravador(alvo));
              rotas.push({
                rota: `${verbo.toUpperCase()} ${juntar(base, argumentoTexto(d))}`,
                handler: `${n.name.text}.${membro.name.getText()}`,
                arquivo: relativo(sf),
                alcancaTrilha,
                soLanca: soLanca(corpo),
                sqlAlcancado: alcancaTrilha ? [] : sqlAlcancado(cx, corpo),
                marcas: [...new Set([...marcasDaClasse, ...marcasDe(ts.getDecorators(membro) ?? [])])].sort(),
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

/** Métodos que registram handler HTTP fora de controller (Nest `INestApplication`/adaptador, Express, MiddlewareConsumer). */
const METODOS_DE_REGISTRO = new Set(['use', 'get', 'post', 'put', 'patch', 'delete', 'all', 'route', 'apply']);
const RE_ORIGEM_HTTP = /\/node_modules\/(@nestjs\/(common|core|platform-express)|@types\/express(-serve-static-core)?|express)\//;

function nomeDoArgumento(a: ts.Expression | undefined): string {
  if (!a) return '';
  if (ts.isCallExpression(a)) return nomeDoArgumento(a.expression);
  if (ts.isIdentifier(a)) return a.text;
  if (ts.isPropertyAccessExpression(a)) return a.name.text;
  if (ts.isStringLiteralLike(a)) return JSON.stringify(a.text);
  return a.kind === ts.SyntaxKind.ArrowFunction || a.kind === ts.SyntaxKind.FunctionExpression ? '<função anônima>' : a.getText().slice(0, 40);
}

/**
 * Handlers HTTP registrados FORA de controller do Nest (R6 do parecer do #117, condição da D4): `app.use(x)`,
 * `adaptador.get('/rota', h)`, `consumer.apply(m)`. O método é identificado pelo símbolo (declarado no Nest ou no
 * Express). Devolve `"<arquivo> <método>(<1º argumento>)"`, ordenado. `extras`: como em `analisarRotas`.
 */
export function handlersForaDeController(extras: readonly string[] = []): string[] {
  const absolutos = extras.map((f) => path.resolve(f));
  const programa = criarPrograma(absolutos);
  const checker = programa.getTypeChecker();
  const doExtra = (f: string) => absolutos.includes(path.resolve(f));
  const achados: string[] = [];
  for (const sf of programa.getSourceFiles()) {
    const f = path.resolve(sf.fileName);
    if (absolutos.length > 0 ? !doExtra(f) : !f.startsWith(RAIZ_SRC)) continue;
    const visitar = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && METODOS_DE_REGISTRO.has(n.expression.name.text)) {
        const decl = checker.getResolvedSignature(n)?.getDeclaration() ?? checker.getSymbolAtLocation(n.expression.name)?.declarations?.[0];
        const origem = decl?.getSourceFile().fileName.split(path.sep).join('/') ?? '';
        // `get/post/...` só é rota com caminho em texto: `app.get(Classe)` é busca no contêiner do Nest, não rota.
        const metodo = n.expression.name.text;
        const ehRota = metodo === 'use' || metodo === 'apply' || (n.arguments[0] !== undefined && (ts.isStringLiteralLike(n.arguments[0]) || ts.isTemplateExpression(n.arguments[0])));
        if (ehRota && RE_ORIGEM_HTTP.test(origem)) achados.push(`${relativo(sf)} ${n.expression.name.text}(${nomeDoArgumento(n.arguments[0])})`);
      }
      ts.forEachChild(n, visitar);
    };
    visitar(sf);
  }
  return achados.sort();
}
