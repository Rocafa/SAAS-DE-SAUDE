/**
 * Provisionamento da clínica e emissão da ativação do fundador (B11, PR 1). Desenho v2:
 * docs/04-arquitetura/provisionamento-da-clinica.md; parecer do Guardião de 16/11/2026 (R1 a R10).
 *
 * Recebe só os dois pools de banco (R8): a tarefa que a chama não carrega `BETTER_AUTH_SECRET`; a conta nova nasce na
 * ativação, pela API (R2, PR 2). Do e-mail do fundador fica só o HMAC (R1); do token, só o SHA-256 (R3). O token volta
 * apenas para quem chamou, pela função `guardarToken`, que roda DENTRO da transação que grava a linha: se guardar
 * falhar, a linha não existe e a repetição emite outro token; se a linha falhar depois, o token guardado não vale nada.
 *
 * Idempotente por pedido (R8): a clínica tem id derivado do uuid do pedido e a linha de ativação tem o próprio uuid do
 * pedido como id. Repetir depois de uma falha parcial completa o que faltou; repetir depois do sucesso recusa com
 * `ja_provisionado` sem criar segunda clínica nem segundo token.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { eq, sql } from 'drizzle-orm';
import { ativacaoDoFundador, usuario } from '../../../db/identidade';
import { tenants } from '../../../db/schema';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { chaveDeHmac } from '../../../security/rate-limit-store';
import { hmacDoEmail } from '../convites';
import { criarClinica } from '../membros';

/** Contrato assinado com a clínica. Só o número: vai para a trilha, o log e o CloudTrail. */
export const CONTRATO = /^CTR-\d{1,7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Validade do token de ativação (72 h, como o convite; resposta 2 do parecer). */
export const VALIDADE_DA_ATIVACAO_HORAS = 72;

export interface PedidoDeProvisionamento {
  /** Uuid do pedido: nome do parâmetro SSM, trava da tarefa e id da linha de ativação. */
  readonly pedido: string;
  /** `CTR-<número>`. */
  readonly contrato: string;
  /** E-mail do fundador, lido do parâmetro SSM. Só o HMAC sai desta função. */
  readonly email: string;
  /** Nome da clínica (pode ser dado pessoal num consultório individual): vem do mesmo parâmetro, nunca de argumento. */
  readonly nomeDaClinica: string;
}

/** Códigos fixos: a saída da tarefa nunca leva a mensagem do driver (R8). */
export type RecusaDoProvisionamento = 'entrada_invalida' | 'contrato_invalido' | 'parametro_invalido' | 'conta_inativa' | 'ja_provisionado';

export class ProvisionamentoRecusado extends Error {
  override readonly name = 'ProvisionamentoRecusado';
  constructor(readonly codigo: RecusaDoProvisionamento) {
    super(codigo);
  }
}

export interface ResultadoDoProvisionamento {
  readonly clinicaId: TenantId;
  readonly pedido: string;
  /** O fundador já tinha conta (a ativação vai pedir login completo, R2). */
  readonly contaExistente: boolean;
}

export interface BancosDoProvisionamento {
  /** Papel `app_auth` (schema identidade). */
  readonly dbAuth: Database;
  /** Papel `app_user` (RLS por clínica). */
  readonly dbClinica: Database;
}

export interface OpcoesDoProvisionamento {
  /** Chave do HMAC do e-mail; padrão: `chaveDeHmac('convite-email')`, a mesma que a ativação vai usar para conferir. */
  readonly chaveDoEmail?: Uint8Array;
}

/** Id da clínica derivado do pedido (formato UUID, versão 5 e variante RFC 4122): repetir o pedido acha a mesma clínica. */
export function clinicaDoPedido(pedido: string): TenantId {
  const h = createHash('sha256').update(`provisionamento/clinica:${pedido}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}` as TenantId;
}

export function hashDoTokenDeAtivacao(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function ehViolacaoDeUnicidade(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

export async function provisionarClinica(
  bancos: BancosDoProvisionamento,
  entrada: PedidoDeProvisionamento,
  guardarToken: (token: string) => Promise<void>,
  opcoes: OpcoesDoProvisionamento = {},
): Promise<ResultadoDoProvisionamento> {
  const { pedido, contrato } = entrada;
  if (!UUID.test(pedido)) throw new ProvisionamentoRecusado('entrada_invalida');
  if (!CONTRATO.test(contrato)) throw new ProvisionamentoRecusado('contrato_invalido');
  const email = entrada.email.trim().toLowerCase();
  const nome = entrada.nomeDaClinica.trim();
  if (email.length > 320 || !EMAIL.test(email) || nome.length === 0 || nome.length > 200) throw new ProvisionamentoRecusado('parametro_invalido');

  // Repetição depois do sucesso: nada muda, nem evento.
  const [ja] = await bancos.dbAuth.select({ id: ativacaoDoFundador.id }).from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, pedido));
  if (ja) throw new ProvisionamentoRecusado('ja_provisionado');

  const chave = opcoes.chaveDoEmail ?? chaveDeHmac('convite-email');
  const emailHmac = hmacDoEmail(email, chave);
  const clinicaId = clinicaDoPedido(pedido);

  // A clínica já existe (falha parcial numa rodada anterior)? Sem 4º argumento: usuário de sistema, só leitura.
  const [existente] = await withTenant(bancos.dbClinica, clinicaId, (tx) =>
    tx.select({ fundador: tenants.founderUserId }).from(tenants).where(eq(tenants.id, clinicaId)),
  );

  let usuarioId: string;
  if (existente?.fundador) {
    usuarioId = existente.fundador;
  } else {
    // Conta existente pelo e-mail, como o convite (`idParaContaDoConvite`). Só a conta ATIVA vira fundador com login
    // completo (R2); a inativa (desligada, convite desfeito, expurgada) não é reaproveitada aqui. A anonimizada já não
    // tem o e-mail.
    const [conta] = await bancos.dbAuth
      .select({ id: usuario.id, ativo: usuario.ativo })
      .from(usuario)
      .where(sql`lower(${usuario.email}) = ${email}`);
    if (conta && !conta.ativo) throw new ProvisionamentoRecusado('conta_inativa');
    usuarioId = conta?.id ?? randomUUID();
    // TODO(R7 do parecer de 16/11/2026, PR 2): a 0022 exige `founder_user_id` = usuário da transação, então
    // `tenant_create` e `member_found` saem hoje com o FUNDADOR como ator, e sem `{ via: 'provisionamento', contract }`
    // na metadata. O PR 2 ajusta a conferência da 0022 para aceitar o ator sistema só com `via: 'provisionamento'`.
    await criarClinica({ run: (t, fn, u) => withTenant(bancos.dbClinica, t, fn, u) }, { clinicaId, nome, fundadorUserId: usuarioId });
    // O operador não é declarado (R7): a prova é o principal da tarefa no CloudTrail.
    registrarEventoDeSeguranca('CLINICA_PROVISIONADA', { tenantId: clinicaId, userId: usuarioId, contrato });
  }
  const [contaDoFundador] = await bancos.dbAuth.select({ id: usuario.id }).from(usuario).where(eq(usuario.id, usuarioId));
  const contaExistente = !!contaDoFundador;

  // 32 bytes aleatórios; no banco, só o SHA-256 (R3).
  const token = randomBytes(32).toString('base64url');
  try {
    await bancos.dbAuth.transaction(async (tx) => {
      await tx.insert(ativacaoDoFundador).values({
        id: pedido,
        clinicaId,
        usuarioId,
        emailHmac,
        contaExistente,
        tokenHash: hashDoTokenDeAtivacao(token),
        contrato,
        // 72 h (VALIDADE_DA_ATIVACAO_HORAS); o CHECK da 0076 recusa mais que isso.
        expiraEm: sql`now() + interval '72 hours'`,
      });
      await guardarToken(token);
    });
  } catch (err) {
    // Corrida com outra rodada do mesmo pedido (id) ou outra ativação pendente da clínica (índice parcial).
    if (ehViolacaoDeUnicidade(err)) throw new ProvisionamentoRecusado('ja_provisionado');
    throw err;
  }
  registrarEventoDeSeguranca('ATIVACAO_EMITIDA', { tenantId: clinicaId, userId: usuarioId, contrato });
  return { clinicaId, pedido, contaExistente };
}
