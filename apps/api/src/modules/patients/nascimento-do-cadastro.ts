import type { Logger } from '@nestjs/common';
import type { RequestContext, TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import { ProibidoError, RegraNaoAtendidaError } from '../../common/erros-dominio';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { IDADE_MAIORIDADE } from '../finance/financeiro-regras';
import { hojeNaClinica } from '../insurance/guias-regras';
import { patientFieldRef } from './patient-fields';
import { aniversarioDe, menorEm, REGRA_INFORMACAO_CLINICA } from './responsaveis-regras';

/**
 * Mudança da data de nascimento do cadastro, compartilhada pelo `PATCH /pacientes/:id` e pelo atendimento do
 * pedido de correção do portal (Conferência 0052, ressalvas 1–5; api-dominio §10d/§10h).
 */

/** 0053: perfis que podem declarar "conferi o documento original". A recepção sozinha não confere. */
export const PERFIS_QUE_CONFEREM_DOCUMENTO = ['admin', 'profissional'] as const;

/** Mesmo código e status nos dois caminhos (ressalva 3): 422 `documento_nao_conferido`, só o NOME do campo. */
export function documentoNaoConferido(): RegraNaoAtendidaError {
  return new RegraNaoAtendidaError('documento_nao_conferido', ['documentoConferido']);
}

/** 403 `conferencia_exige_perfil` quando quem declara a conferência não é admin nem profissional (o banco confere o mesmo). */
export function exigirPerfilQueConfere(ctx: RequestContext): void {
  if (!ctx.roles.some((p) => (PERFIS_QUE_CONFEREM_DOCUMENTO as readonly string[]).includes(p))) {
    throw new ProibidoError('conferencia_exige_perfil');
  }
}

/**
 * Data de nascimento vigente decifrada. Cifra ilegível (chave, AAD de outra linha) não derruba a transação
 * (savepoint): volta `ilegivel: true` e valor null, que a regra trata como DESCONHECIDA (falha fechada: exige
 * documento para gravar uma data).
 */
export async function nascimentoVigente(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  pacienteId: string,
  enc: string | null,
): Promise<{ valor: string | null; ilegivel: boolean }> {
  if (enc === null) return { valor: null, ilegivel: false };
  try {
    const valor = await tx.transaction((sp) => cipher.decryptString(sp, patientFieldRef(tenantId, pacienteId, 'birth_date'), enc));
    return { valor, ilegivel: false };
  } catch {
    return { valor: null, ilegivel: true };
  }
}

/**
 * N3 do #68 (conferência de 22/10) e R1 do #73: a data de nascimento mudou nesta transação. O gatilho da 0038
 * marcou a mudança; aqui se recalcula pelo dia dos 12 (sigilo do adolescente) e dos 18 (fim da representação)
 * da data nova. Sem data válida, fecha. O banco só reabre com a marca desta transação (que consome) e grava a
 * trilha; se ninguém recalcular, o COMMIT fecha. `documentoConferido`: põe antes a marca de conferência da
 * 0052/0053 (o banco exige perfil admin/profissional e grava quem e qual perfil, sem a data).
 */
export async function recalcularSigiloDoPortal(
  tx: TenantTx,
  logger: Logger,
  dados: { pacienteId: string; nascimento: string | null; emancipadoEm: string | null; documentoConferido: boolean },
): Promise<void> {
  const id = dados.pacienteId;
  if (dados.documentoConferido) await tx.execute(sql`select app_patient_birth_date_document_checked(${id}::uuid)`);
  const nascimento = dados.nascimento;
  const valida = nascimento !== null && /^\d{4}-\d{2}-\d{2}$/.test(nascimento);
  const sigilo = valida ? aniversarioDe(nascimento, REGRA_INFORMACAO_CLINICA.idadeInicioAdolescencia) : null;
  const maioridade = valida ? aniversarioDe(nascimento, IDADE_MAIORIDADE) : null;
  await tx.execute(sql`select app_portal_recalc_sigilo(${id}::uuid, ${sigilo}::date, ${maioridade}::date)`);
  // R3 do #68 (0050): pela data nova o paciente é menor não emancipado = o acesso de TITULAR ao portal cai
  // nesta mesma transação (vínculos revogados, convites pendentes encerrados, trilha com o usuário, aviso e
  // alerta do banco). O job `portal-titular-menor` (§14) é a rede de segurança do que escapar deste caminho.
  if (menorEm(nascimento, hojeNaClinica(), dados.emancipadoEm) === true) {
    await tx.execute(sql`select * from app_portal_revoke_minor_titular(${id}::uuid)`);
  }
  // N1 do #73 (0039): o banco já gravou aviso e anomaly_alert da transição perigosa; o log com marcador fixo
  // (só a regra e a transição) alimenta o alarme de operação, como nos alertas do #61.
  const alertas = await tx.execute<{ transicao: string }>(
    sql`select metadata->>'transition' as transicao from audit_log
         where tenant_id = app_current_tenant() and action = 'anomaly_alert' and created_at = now()
           and metadata->>'rule' = 'portal_sigilo_transicao'`,
  );
  for (const a of alertas) logger.warn(`ALERTA_ANOMALIA regra=portal_sigilo_transicao transicao=${a.transicao}`);
}
