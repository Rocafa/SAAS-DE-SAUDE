/**
 * Comando operacional do provisionamento da clínica (B11, PR 1). Roda como tarefa avulsa do ECS, com definição e papel
 * de tarefa próprios, só com as credenciais de banco (`app_auth` e `app_user`), a raiz do HMAC por uso e o log de
 * segurança (R8 do parecer de 16/11/2026). Desenho: docs/04-arquitetura/provisionamento-da-clinica.md.
 *
 *   node dist/ops/provisionar-clinica.js --pedido <uuid> --contrato CTR-<n>
 *   (com CONFIRMA_PROVISIONAMENTO=<o mesmo uuid do pedido> no ambiente da tarefa)
 *
 * Entrada (R1, P1): o e-mail do fundador e o nome da clínica chegam por um parâmetro SecureString do SSM,
 * `/provisionamento/<pedido>`, com o JSON `{"email": "...", "clinica": "..."}`. Nenhum dado pessoal vai para argumento ou
 * para o CloudTrail. O parâmetro é apagado no fim, com sucesso ou falha (R9).
 *
 * Saída (R3): o token vai para um SEGUNDO parâmetro, `/provisionamento/<pedido>/entrega`, que outra pessoa lê e apaga.
 * Pelo Logger sai uma linha só: `ok <clinica> <pedido>` ou um código fixo. Nunca e-mail, nome, token ou a mensagem do
 * driver (R8).
 */
import { Logger } from '@nestjs/common';
import { createDatabase } from '../db/tenant-transaction';
import {
  CONTRATO,
  provisionarClinica,
  ProvisionamentoRecusado,
  type BancosDoProvisionamento,
  type PedidoDeProvisionamento,
  type ResultadoDoProvisionamento,
} from '../modules/auth/better-auth/provisionamento';

export type CodigoDoComando =
  | 'ok'
  | 'uso_incorreto'
  | 'trava_incorreta'
  | 'contrato_invalido'
  | 'parametro_ausente'
  | 'parametro_invalido'
  | 'ja_provisionado'
  | 'conta_inativa'
  | 'erro_parcial_rodar_de_novo'
  | 'ssm_nao_configurado';

/** Acesso ao SSM, injetado (o teste usa dublês; a tarefa, o cliente real). */
export interface ParametrosSeguros {
  /** Valor decifrado do SecureString, ou `null` se o parâmetro não existe. */
  readonly ler: (nome: string) => Promise<string | null>;
  /** SecureString; sobrescreve o de uma rodada anterior cuja linha de ativação não gravou (aquele token não vale nada). */
  readonly gravar: (nome: string, valor: string) => Promise<void>;
  readonly apagar: (nome: string) => Promise<void>;
}

export interface DependenciasDoComando {
  readonly parametros: ParametrosSeguros;
  readonly provisionar: (entrada: PedidoDeProvisionamento, guardarToken: (token: string) => Promise<void>) => Promise<ResultadoDoProvisionamento>;
}

export interface SaidaDoComando {
  readonly codigo: CodigoDoComando;
  /** A única linha impressa. */
  readonly linha: string;
}

const saidaDoComando = new Logger('ops-provisionamento');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLAGS = ['--pedido', '--contrato'] as const;

export const parametroDoPedido = (pedido: string): string => `/provisionamento/${pedido}`;
export const parametroDaEntrega = (pedido: string): string => `/provisionamento/${pedido}/entrega`;

function lerArgumentos(argv: readonly string[]): Record<(typeof FLAGS)[number], string> | null {
  const valores: Partial<Record<(typeof FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as (typeof FLAGS)[number];
    const valor = argv[i + 1];
    if (!FLAGS.includes(flag) || valor === undefined || valores[flag] !== undefined) return null;
    valores[flag] = valor;
  }
  return FLAGS.every((f) => valores[f] !== undefined) ? (valores as Record<(typeof FLAGS)[number], string>) : null;
}

/** O JSON do parâmetro, com só as duas chaves esperadas. Qualquer outra forma é `null` (sem dizer o que veio). */
function lerConteudo(valor: string): { email: string; clinica: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(valor);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const { email, clinica, ...resto } = obj as Record<string, unknown>;
  if (Object.keys(resto).length > 0 || typeof email !== 'string' || typeof clinica !== 'string') return null;
  return { email, clinica };
}

const falha = (codigo: CodigoDoComando): SaidaDoComando => ({ codigo, linha: codigo });

export async function executarComando(argv: readonly string[], env: NodeJS.ProcessEnv, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const args = lerArgumentos(argv);
  if (!args || !UUID.test(args['--pedido'])) return falha('uso_incorreto');
  const pedido = args['--pedido'];
  // Trava contra erro de digitação: o uuid repetido no ambiente da tarefa. Recusa antes de ler ou escrever qualquer coisa.
  if (env.CONFIRMA_PROVISIONAMENTO !== pedido) return falha('trava_incorreta');
  if (!CONTRATO.test(args['--contrato'])) return falha('contrato_invalido');

  const nome = parametroDoPedido(pedido);
  let valor: string | null;
  try {
    valor = await deps.parametros.ler(nome);
  } catch {
    return falha('erro_parcial_rodar_de_novo');
  }
  if (valor === null) return falha('parametro_ausente');

  let saida: SaidaDoComando;
  try {
    const conteudo = lerConteudo(valor);
    if (!conteudo) {
      saida = falha('parametro_invalido');
    } else {
      const r = await deps.provisionar({ pedido, contrato: args['--contrato'], email: conteudo.email, nomeDaClinica: conteudo.clinica }, (token) =>
        deps.parametros.gravar(parametroDaEntrega(pedido), token),
      );
      saida = { codigo: 'ok', linha: `ok ${r.clinicaId} ${r.pedido}` };
    }
  } catch (err) {
    if (err instanceof ProvisionamentoRecusado) {
      saida = falha(err.codigo === 'entrada_invalida' ? 'uso_incorreto' : err.codigo);
    } else {
      // Erro do banco ou do SSM: a tarefa é idempotente, então a saída é rodar de novo. Nunca a mensagem do driver.
      saida = falha('erro_parcial_rodar_de_novo');
    }
  }
  // R9: o parâmetro com o e-mail sai também quando a tarefa falha. Se não sair, pede-se nova rodada (que o apaga).
  try {
    await deps.parametros.apagar(nome);
  } catch {
    return falha('erro_parcial_rodar_de_novo');
  }
  return saida;
}

/**
 * Cliente real do SSM. `@aws-sdk/client-ssm` ainda não é dependência da API (só `client-kms`), e este PR não adiciona
 * pacote.
 * TODO(B11, PR do Terraform `ops-provisionamento`): adicionar `@aws-sdk/client-ssm` e implementar `ler`
 * (GetParameter com WithDecryption), `gravar` (PutParameter SecureString, Overwrite true, chave KMS própria) e `apagar`
 * (DeleteParameter), com o papel da tarefa restrito a `/provisionamento/*`.
 */
function parametrosDoSsm(): ParametrosSeguros | null {
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
  const bancos: BancosDoProvisionamento = { dbAuth: dbAuth.db, dbClinica: dbClinica.db };
  try {
    const saida = await executarComando(process.argv.slice(2), process.env, {
      parametros,
      provisionar: (entrada, guardarToken) => provisionarClinica(bancos, entrada, guardarToken),
    });
    saidaDoComando.log(saida.linha);
    process.exitCode = saida.codigo === 'ok' ? 0 : 1;
  } finally {
    await Promise.allSettled([dbAuth.close(), dbClinica.close()]);
  }
}

if (require.main === module) {
  principal().catch(() => {
    saidaDoComando.log('erro_parcial_rodar_de_novo');
    process.exitCode = 1;
  });
}
