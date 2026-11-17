/**
 * Comando operacional da recuperação do FATOR do admin único pelo suporte (B12). Roda como tarefa avulsa do ECS, com
 * definição e papel de tarefa próprios (`ops-recuperacao`), só com as credenciais de banco `app_auth` e `app_user` (R4 do
 * parecer do Guardião de 16/11/2026). Desenho: docs/04-arquitetura/recuperacao-do-admin-unico.md. Runbook:
 * docs/04-arquitetura/runbook-recuperacao-admin-unico.md. A recuperação completa (senha e fator) é VETADA: não existe.
 *
 *   node dist/ops/recuperar-admin-unico.js --clinica <uuid> --usuario <uuid> --chamado SUP-<n> --operador <uuid>
 *     --motivo <perdeu_o_aparelho|troca_de_aparelho|suspeita_de_invasao|conta_bloqueada> [--derrubar-sessoes]
 *   (com CONFIRMA_RECUPERACAO=<o mesmo uuid do usuário> no ambiente da tarefa)
 *
 * Saída do token (R3, R7): um parâmetro SecureString do SSM, `/recuperacao-suporte/<usuario>/entrega`, que OUTRA pessoa
 * lê uma vez e apaga. Se a tarefa falha depois de gravá-lo, ele é apagado aqui.
 * Pelo Logger sai uma linha só: `ok <usuario> expira=<iso> sessoes=<n>` ou um código fixo. Nunca token, nome, e-mail ou a
 * mensagem do driver.
 */
import { Logger } from '@nestjs/common';
import { createDatabase } from '../db/tenant-transaction';
import {
  emitirRecuperacaoPeloSuporte,
  RecuperacaoPeloSuporteRecusada,
  type BancosDaRecuperacaoPeloSuporte,
  type PedidoDeRecuperacaoPeloSuporte,
  type ResultadoDaRecuperacaoPeloSuporte,
} from '../modules/auth/better-auth/recuperacao-pelo-suporte';

export type CodigoDoComando = 'ok' | 'uso_incorreto' | 'trava_incorreta' | 'erro' | 'ssm_nao_configurado' | RecuperacaoPeloSuporteRecusada['codigo'];

/** Acesso ao SSM, injetado (o teste usa dublês; a tarefa, o cliente real). */
export interface ParametroDeEntrega {
  /** SecureString com chave KMS própria; sobrescreve o de uma rodada anterior (aquele token já foi invalidado). */
  readonly gravar: (nome: string, valor: string) => Promise<void>;
  readonly apagar: (nome: string) => Promise<void>;
}

export interface DependenciasDoComando {
  readonly parametros: ParametroDeEntrega;
  readonly emitir: (pedido: PedidoDeRecuperacaoPeloSuporte, guardarToken: (token: string) => Promise<void>) => Promise<ResultadoDaRecuperacaoPeloSuporte>;
}

export interface SaidaDoComando {
  readonly codigo: CodigoDoComando;
  /** A única linha impressa. */
  readonly linha: string;
}

const saidaDoComando = new Logger('ops-recuperacao');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLAGS = ['--clinica', '--usuario', '--chamado', '--operador', '--motivo'] as const;
const DERRUBAR = '--derrubar-sessoes';
type Flag = (typeof FLAGS)[number];

export const parametroDaEntrega = (usuarioId: string): string => `/recuperacao-suporte/${usuarioId}/entrega`;

function lerArgumentos(argv: readonly string[]): { valores: Record<Flag, string>; derrubarSessoes: boolean } | null {
  const valores: Partial<Record<Flag, string>> = {};
  let derrubarSessoes = false;
  for (let i = 0; i < argv.length; ) {
    const flag = argv[i];
    if (flag === DERRUBAR) {
      if (derrubarSessoes) return null;
      derrubarSessoes = true;
      i += 1;
      continue;
    }
    const valor = argv[i + 1];
    if (!FLAGS.includes(flag as Flag) || valor === undefined || valor.startsWith('--') || valores[flag as Flag] !== undefined) return null;
    valores[flag as Flag] = valor;
    i += 2;
  }
  return FLAGS.every((f) => valores[f] !== undefined) ? { valores: valores as Record<Flag, string>, derrubarSessoes } : null;
}

const falha = (codigo: CodigoDoComando): SaidaDoComando => ({ codigo, linha: codigo });

export async function executarComando(argv: readonly string[], env: NodeJS.ProcessEnv, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const args = lerArgumentos(argv);
  if (!args || !UUID.test(args.valores['--usuario'])) return falha('uso_incorreto');
  const usuarioId = args.valores['--usuario'];
  // Trava contra erro de digitação: o uuid repetido no ambiente da tarefa. Recusa antes de ler ou escrever qualquer coisa.
  if (env.CONFIRMA_RECUPERACAO !== usuarioId) return falha('trava_incorreta');

  const nome = parametroDaEntrega(usuarioId);
  let gravou = false;
  let saida: SaidaDoComando;
  try {
    const r = await deps.emitir(
      {
        clinicaId: args.valores['--clinica'],
        usuarioId,
        chamado: args.valores['--chamado'],
        operador: args.valores['--operador'],
        motivo: args.valores['--motivo'] as PedidoDeRecuperacaoPeloSuporte['motivo'],
        derrubarSessoes: args.derrubarSessoes,
      },
      async (token) => {
        gravou = true;
        await deps.parametros.gravar(nome, token);
      },
    );
    return { codigo: 'ok', linha: `ok ${usuarioId} expira=${r.expiraEm} sessoes=${r.sessoesDerrubadas}` };
  } catch (err) {
    // Nunca a mensagem do driver ou do SSM: só o código fixo.
    saida = falha(err instanceof RecuperacaoPeloSuporteRecusada ? (err.codigo === 'entrada_invalida' ? 'uso_incorreto' : err.codigo) : 'erro');
  }
  // R7: o parâmetro desta rodada sai quando a tarefa falha depois de gravá-lo (o token já foi invalidado ou não ficou).
  // Só o desta rodada: uma recusa (teto, outro admin) não apaga a entrega pendente de uma rodada anterior.
  if (gravou) {
    try {
      await deps.parametros.apagar(nome);
    } catch {
      return falha('erro');
    }
  }
  return saida;
}

/**
 * Cliente real do SSM. `@aws-sdk/client-ssm` ainda não é dependência da API (só `client-kms`), e este PR não adiciona
 * pacote.
 * TODO(B12, PR do Terraform `ops-recuperacao`): adicionar `@aws-sdk/client-ssm` e implementar `gravar` (PutParameter
 * SecureString, Overwrite true, chave KMS própria, com a política de vencimento em 24 h) e `apagar` (DeleteParameter,
 * ignorando ParameterNotFound), com o papel da tarefa restrito a `/recuperacao-suporte/*`.
 */
function parametrosDoSsm(): ParametroDeEntrega | null {
  return null;
}

async function principal(): Promise<void> {
  const authUrl = process.env.DATABASE_AUTH_URL;
  const clinicaUrl = process.env.DATABASE_URL;
  if (!authUrl || !clinicaUrl) {
    saidaDoComando.log('uso_incorreto');
    process.exitCode = 2;
    return;
  }
  const parametros = parametrosDoSsm();
  if (!parametros) {
    saidaDoComando.log('ssm_nao_configurado');
    process.exitCode = 2;
    return;
  }
  const dbAuth = createDatabase(authUrl, { max: 1 });
  const dbClinica = createDatabase(clinicaUrl, { max: 1 });
  const bancos: BancosDaRecuperacaoPeloSuporte = { dbAuth: dbAuth.db, dbClinica: dbClinica.db };
  try {
    const saida = await executarComando(process.argv.slice(2), process.env, {
      parametros,
      emitir: (pedido, guardarToken) => emitirRecuperacaoPeloSuporte(bancos, pedido, guardarToken),
    });
    saidaDoComando.log(saida.linha);
    process.exitCode = saida.codigo === 'ok' ? 0 : 1;
  } finally {
    await Promise.allSettled([dbAuth.close(), dbClinica.close()]);
  }
}

if (require.main === module) {
  principal().catch(() => {
    saidaDoComando.log('erro');
    process.exitCode = 1;
  });
}
