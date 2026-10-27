import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { GuardianKind } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';

/**
 * De onde vem o telefone do RESPONSÁVEL do paciente (R10 do RIPD-whatsapp: titular ≠ destinatário).
 *
 * Integração da rodada 19 (R4 do #69): os responsáveis são os da 0028 (`guardians` + `patient_guardians`);
 * `whatsapp_opt_ins.guardian_id` e `whatsapp_outbox.guardian_id` têm FK para `guardians` (migração 0036).
 * A porta só diz se há vínculo VIGENTE (e de que tipo); a regra de maioridade/emancipação fica no serviço
 * (`representaParaWhatsapp`), que tem a data de nascimento decifrada.
 */
export interface ResponsavelVigente {
  /** Telefone decifrado; null se a pessoa não tem telefone (ou foi descartada). */
  readonly telefone: string | null;
  /** Tipo do vínculo (curatela continua valendo depois dos 18 anos; os demais, não). */
  readonly tipo: GuardianKind;
}

export interface FonteDeResponsaveis {
  /**
   * Vínculo VIGENTE HOJE entre o paciente e a pessoa responsável, na clínica do contexto (não encerrado,
   * não anulado, não eliminado, dentro de [desde, até)); `null` se não há.
   */
  responsavelVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, responsavelId: string): Promise<ResponsavelVigente | null>;
}

export const FONTE_DE_RESPONSAVEIS = Symbol('FONTE_DE_RESPONSAVEIS');

export class ResponsaveisPeloCatalogo implements FonteDeResponsaveis {
  constructor(private readonly cipher: FieldCipher<TenantTx>) {}

  async responsavelVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, responsavelId: string): Promise<ResponsavelVigente | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(responsavelId)) return null;
    // Mesma noção de "vigente" que o banco usa (app_whatsapp_guardian_ok, 0036): RLS da clínica do contexto.
    const linhas = await tx.execute<{ phone_enc: string | null; kind: GuardianKind }>(sql`
      select g.phone_enc, pg.kind
        from patient_guardians pg
        join guardians g on g.id = pg.guardian_id and g.tenant_id = pg.tenant_id
       where pg.tenant_id = ${tenantId} and pg.patient_id = ${pacienteId} and pg.guardian_id = ${responsavelId}
         and pg.ended_at is null and pg.end_reason is null and pg.eliminated_at is null
         and pg.valid_from <= app_fiscal_today()
         and (pg.valid_until is null or pg.valid_until > app_fiscal_today())
       order by pg.valid_from desc
       limit 1`);
    const linha = linhas[0];
    if (!linha) return null;
    const telefone =
      linha.phone_enc === null
        ? null
        : await this.cipher.decryptString(tx, { tenantId, table: 'guardians', column: 'phone', rowId: responsavelId }, linha.phone_enc);
    return { telefone, tipo: linha.kind };
  }
}
