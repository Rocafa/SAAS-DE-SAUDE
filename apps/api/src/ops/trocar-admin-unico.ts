/**
 * Comando operacional da troca do admin único que perdeu senha e fator (B13). Roda como tarefa avulsa do ECS, no
 * padrão do provisionamento (B11): só a credencial do papel de banco dedicado (`app_provisionamento`, 0080 ampliado
 * pela 0082; P7), a raiz do HMAC por uso e o log de segurança. Desenho: docs/04-arquitetura/troca-do-admin-unico.md.
 * Runbook: docs/04-arquitetura/runbook-troca-do-admin-unico.md.
 *
 *   node dist/ops/trocar-admin-unico.js --fase pedir --pedido <uuid> --clinica <uuid> --usuario <uuid da conta antiga>
 *     --chamado SUP-<n> --contrato CTR-<n> --motivo <perdeu_senha_e_fator|titular_indisponivel|suspeita_de_invasao>
 *     --operador <uuid> --viva-voz <hora UTC> [--suspender-conta-antiga]
 *   node dist/ops/trocar-admin-unico.js --fase emitir --pedido <uuid> --chamado SUP-<n> --operador <uuid> --viva-voz <hora UTC>
 *   node dist/ops/trocar-admin-unico.js --fase cancelar --pedido <uuid> --chamado SUP-<n> --operador <uuid> --por <contrato|dpo>
 *   (sempre com CONFIRMA_TROCA=<o mesmo uuid do pedido> no ambiente da tarefa)
 *
 * Entrada (`pedir`): o e-mail da conta NOVA chega por um SecureString do SSM, `/troca-admin/<pedido>`, com o JSON
 * `{"email": "..."}`; o parâmetro é apagado no fim, com sucesso ou falha. Nenhum dado pessoal em argumento.
 * Saída (`emitir`): o token vai para `/troca-admin/<pedido>/entrega` (24 h), que uma TERCEIRA pessoa lê uma vez e apaga
 * (P3). Se a tarefa falha depois de gravá-lo, ele é apagado aqui.
 * Pelo Logger sai uma linha só: `ok ...` ou um código fixo. Nunca e-mail, token ou a mensagem do driver.
 */
import { Logger } from '@nestjs/common';
import { createDatabase, type Database } from '../db/tenant-transaction';
import {
  cancelarTrocaDoAdmin,
  emitirTrocaDoAdmin,
  pedirTrocaDoAdmin,
  TrocaRecusada,
  type CancelamentoDaTroca,
  type EmissaoDaTroca,
  type MotivoDaTroca,
  type PedidoDeTroca,
  type QuemCancela,
  type RecusaDaTroca,
  type ResultadoDaEmissao,
  type ResultadoDoPedido,
} from '../modules/auth/better-auth/troca-do-admin';
import { EntregaPendente, parametrosSsmDoAmbiente, VALIDADE_DA_ENTREGA_HORAS } from './parametros-ssm';

export type CodigoDoComando =
  | 'ok'
  | 'uso_incorreto'
  | 'trava_incorreta'
  | 'parametro_ausente'
  | 'parametro_invalido'
  | 'entrega_pendente'
  | 'ssm_nao_configurado'
  | 'pedido_vencimento_invalido'
  | 'erro'
  | Exclude<RecusaDaTroca, 'entrada_invalida'>;

/** Acesso ao SSM, injetado (o teste usa dublês; a tarefa, o cliente real de `parametros-ssm.ts`). */
export interface ParametrosDaTroca {
  readonly ler: (nome: string) => Promise<string | null>;
  /** SecureString com a chave do fluxo, 24 h, sem sobrescrever (`EntregaPendente` se a anterior ainda está lá). */
  readonly gravar: (nome: string, valor: string) => Promise<void>;
  readonly apagar: (nome: string) => Promise<void>;
  /** Gravação e vencimento (`Expiration`) do parâmetro, sem o valor (`parametros-ssm.ts`). */
  readonly vencimento: (nome: string) => Promise<{ readonly gravadoEm: Date | null; readonly venceEm: Date | null } | null>;
}

export interface DependenciasDoComando {
  readonly parametros: ParametrosDaTroca;
  readonly agora?: () => Date;
  readonly pedir: (p: PedidoDeTroca) => Promise<ResultadoDoPedido>;
  readonly emitir: (e: EmissaoDaTroca, guardarToken: (token: string) => Promise<void>) => Promise<ResultadoDaEmissao>;
  readonly cancelar: (c: CancelamentoDaTroca) => Promise<{ readonly clinicaId: string }>;
}

export interface SaidaDoComando {
  readonly codigo: CodigoDoComando;
  /** A única linha impressa. */
  readonly linha: string;
}

const saidaDoComando = new Logger('ops-troca-admin');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUSPENDER = '--suspender-conta-antiga';
const FLAGS = {
  pedir: ['--pedido', '--clinica', '--usuario', '--chamado', '--contrato', '--motivo', '--operador', '--viva-voz'],
  emitir: ['--pedido', '--chamado', '--operador', '--viva-voz'],
  cancelar: ['--pedido', '--chamado', '--operador', '--por'],
} as const;
type Fase = keyof typeof FLAGS;

export const parametroDoPedido = (pedido: string): string => `/troca-admin/${pedido}`;
export const parametroDaEntrega = (pedido: string): string => `/troca-admin/${pedido}/entrega`;

interface Argumentos {
  readonly fase: Fase;
  readonly valores: Readonly<Record<string, string>>;
  readonly suspender: boolean;
}

function lerArgumentos(argv: readonly string[]): Argumentos | null {
  const valores: Record<string, string> = {};
  let suspender = false;
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i] ?? '';
    if (flag === SUSPENDER) {
      if (suspender) return null;
      suspender = true;
      i += 1;
      continue;
    }
    const valor = argv[i + 1];
    if (!flag.startsWith('--') || valor === undefined || valor.startsWith('--') || valores[flag] !== undefined) return null;
    valores[flag] = valor;
    i += 2;
  }
  const fase = valores['--fase'];
  if (fase !== 'pedir' && fase !== 'emitir' && fase !== 'cancelar') return null;
  const esperadas: readonly string[] = ['--fase', ...FLAGS[fase]];
  if (Object.keys(valores).some((f) => !esperadas.includes(f)) || esperadas.some((f) => valores[f] === undefined)) return null;
  // A suspensão da conta antiga (P2) só existe no `pedir`.
  if (suspender && fase !== 'pedir') return null;
  return { fase, valores, suspender };
}

/** O JSON do parâmetro do pedido, só com a chave `email`. Qualquer outra forma é `null` (sem dizer o que veio). */
function lerConteudo(valor: string): { email: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(valor);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const { email, ...resto } = obj as Record<string, unknown>;
  if (Object.keys(resto).length > 0 || typeof email !== 'string') return null;
  return { email };
}

const falha = (codigo: CodigoDoComando): SaidaDoComando => ({ codigo, linha: codigo });

/** Vencimento máximo do parâmetro do pedido (`Expiration`), contado da gravação. Tolerância de relógio: 1 min. */
export const VALIDADE_MAXIMA_DO_PEDIDO_HORAS = 72;

export function vencimentoDoPedidoConfere(v: { readonly gravadoEm: Date | null; readonly venceEm: Date | null } | null, agora: Date): boolean {
  if (!v?.venceEm) return false;
  const base = v.gravadoEm ?? agora;
  return v.venceEm.getTime() - base.getTime() <= VALIDADE_MAXIMA_DO_PEDIDO_HORAS * 3_600_000 + 60_000;
}

function codigoDoErro(err: unknown): CodigoDoComando {
  if (err instanceof EntregaPendente) return 'entrega_pendente';
  if (err instanceof TrocaRecusada) return err.codigo === 'entrada_invalida' ? 'uso_incorreto' : err.codigo;
  // Nunca a mensagem do driver ou do SSM.
  return 'erro';
}

export async function executarComando(argv: readonly string[], env: NodeJS.ProcessEnv, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const args = lerArgumentos(argv);
  const pedido = args?.valores['--pedido'] ?? '';
  if (!args || !UUID.test(pedido)) return falha('uso_incorreto');
  // Trava contra erro de digitação: o uuid do pedido repetido no ambiente. Recusa antes de ler ou escrever qualquer coisa.
  if (env.CONFIRMA_TROCA !== pedido) return falha('trava_incorreta');
  const v = args.valores;
  if (args.fase === 'pedir') return pedir(pedido, args, deps);
  if (args.fase === 'cancelar') {
    try {
      await deps.cancelar({ pedido, chamado: v['--chamado'] ?? '', operador: v['--operador'] ?? '', por: v['--por'] as QuemCancela });
      return { codigo: 'ok', linha: `ok ${pedido} cancelada` };
    } catch (err) {
      return falha(codigoDoErro(err));
    }
  }
  return emitir(pedido, v, deps);
}

async function pedir(pedido: string, args: Argumentos, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const nome = parametroDoPedido(pedido);
  let valor: string | null;
  try {
    valor = await deps.parametros.ler(nome);
  } catch {
    return falha('erro');
  }
  if (valor === null) return falha('parametro_ausente');
  let saida: SaidaDoComando;
  // Recomendação do Guardião no parecer do #240: o pedido (com o e-mail) não fica no SSM mais que 72 h. A tarefa confere
  // a política `Expiration` em vez de confiar só no comando do operador: sem ela, ou vencendo depois de 72 h da gravação
  // (ou de agora, sem a data da gravação), recusa; o parâmetro é apagado logo abaixo, como em toda saída.
  let vencimentoOk: boolean;
  try {
    vencimentoOk = vencimentoDoPedidoConfere(await deps.parametros.vencimento(nome), (deps.agora ?? (() => new Date()))());
  } catch {
    vencimentoOk = false;
  }
  const conteudo = vencimentoOk ? lerConteudo(valor) : null;
  if (!vencimentoOk) {
    saida = falha('pedido_vencimento_invalido');
  } else if (!conteudo) {
    saida = falha('parametro_invalido');
  } else {
    const v = args.valores;
    try {
      const r = await deps.pedir({
        pedido,
        clinicaId: v['--clinica'] ?? '',
        usuarioAntigo: v['--usuario'] ?? '',
        chamado: v['--chamado'] ?? '',
        contrato: v['--contrato'] ?? '',
        motivo: v['--motivo'] as MotivoDaTroca,
        operador: v['--operador'] ?? '',
        vivaVoz: v['--viva-voz'] ?? '',
        suspenderContaAntiga: args.suspender,
        email: conteudo.email,
      });
      saida = { codigo: 'ok', linha: `ok ${pedido} libera=${r.liberaEm} sessoes=${r.sessoesDerrubadas}` };
    } catch (err) {
      saida = falha(codigoDoErro(err));
    }
  }
  // O parâmetro com o e-mail sai também quando a tarefa falha. Se não sair, a saída é `erro` (rodar de novo o apaga).
  try {
    await deps.parametros.apagar(nome);
  } catch {
    return falha('erro');
  }
  return saida;
}

async function emitir(pedido: string, v: Readonly<Record<string, string>>, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const nome = parametroDaEntrega(pedido);
  let gravou = false;
  let saida: SaidaDoComando;
  try {
    const r = await deps.emitir({ pedido, chamado: v['--chamado'] ?? '', operador: v['--operador'] ?? '', vivaVoz: v['--viva-voz'] ?? '' }, async (token) => {
      // Conta como gravado também o erro ambíguo (o SSM pode ter gravado antes de falhar). Só a entrega pendente de uma
      // rodada anterior garante que nada desta rodada ficou, e essa não pode ser apagada aqui.
      gravou = true;
      try {
        await deps.parametros.gravar(nome, token);
      } catch (err) {
        if (err instanceof EntregaPendente) gravou = false;
        throw err;
      }
    });
    return { codigo: 'ok', linha: `ok ${pedido} ${r.tipo} expira=${r.expiraEm}` };
  } catch (err) {
    saida = falha(codigoDoErro(err));
  }
  // A transação desfez a emissão: o token desta rodada não vale, e a entrega dela sai.
  if (gravou) {
    try {
      await deps.parametros.apagar(nome);
    } catch {
      return falha('erro');
    }
  }
  return saida;
}

async function principal(): Promise<void> {
  // Só o papel dedicado (0080/0082). Nem `app_auth` nem `app_user`.
  const url = process.env.DATABASE_PROVISIONAMENTO_URL;
  if (!url) {
    saidaDoComando.log('uso_incorreto');
    process.exitCode = 2;
    return;
  }
  const parametros = parametrosSsmDoAmbiente(process.env, VALIDADE_DA_ENTREGA_HORAS.troca);
  if (!parametros) {
    saidaDoComando.log('ssm_nao_configurado');
    process.exitCode = 2;
    return;
  }
  // Uma conexão basta: cada fase é uma transação só.
  const banco = createDatabase(url, { max: 1 });
  const db: Database = banco.db;
  try {
    const saida = await executarComando(process.argv.slice(2), process.env, {
      parametros,
      pedir: (p) => pedirTrocaDoAdmin(db, p),
      emitir: (e, guardar) => emitirTrocaDoAdmin(db, e, guardar),
      cancelar: (c) => cancelarTrocaDoAdmin(db, c),
    });
    saidaDoComando.log(saida.linha);
    process.exitCode = saida.codigo === 'ok' ? 0 : 1;
  } finally {
    await banco.close();
  }
}

if (require.main === module) {
  principal().catch(() => {
    saidaDoComando.log('erro');
    process.exitCode = 1;
  });
}
