import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';

/**
 * De onde vem o telefone do RESPONSÁVEL do paciente (R10 do RIPD-whatsapp: titular ≠ destinatário).
 *
 * Os responsáveis (`guardians` + `patient_guardians`, migração 0028) estão em OUTRA branch
 * (eng/responsaveis). Esta porta tolera a ausência: `ResponsaveisPeloCatalogo` olha o catálogo e, sem as
 * tabelas, responde "não há responsável" — o lembrete de menor simplesmente não sai (falha fechada).
 * Quando as branches se encontrarem, nada muda aqui: as tabelas passam a existir e a consulta roda.
 */
export interface FonteDeResponsaveis {
  /**
   * Vínculo VIGENTE entre o paciente e a pessoa responsável, na clínica do contexto. Devolve o telefone
   * decifrado (ou null se a pessoa não tem telefone), ou `null` se não há vínculo vigente.
   */
  responsavelVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, responsavelId: string): Promise<{ readonly telefone: string | null } | null>;
}

export const FONTE_DE_RESPONSAVEIS = Symbol('FONTE_DE_RESPONSAVEIS');

export class ResponsaveisPeloCatalogo implements FonteDeResponsaveis {
  constructor(private readonly cipher: FieldCipher<TenantTx>) {}

  async responsavelVigente(tx: TenantTx, tenantId: TenantId, pacienteId: string, responsavelId: string): Promise<{ readonly telefone: string | null } | null> {
    const [cat] = await tx.execute<{ existe: boolean }>(
      sql`select (to_regclass('public.patient_guardians') is not null and to_regclass('public.guardians') is not null) as existe`,
    );
    if (!cat?.existe) return null;
    // Colunas da 0028 (eng/responsaveis): vínculo vivo e vigente hoje; RLS da clínica do contexto.
    const linhas = await tx.execute<{ phone_enc: string | null }>(sql`
      select g.phone_enc
        from patient_guardians pg
        join guardians g on g.id = pg.guardian_id and g.tenant_id = pg.tenant_id
       where pg.tenant_id = ${tenantId} and pg.patient_id = ${pacienteId} and pg.guardian_id = ${responsavelId}
         and pg.ended_at is null and pg.valid_from <= current_date
         and (pg.valid_until is null or pg.valid_until > current_date)
       limit 1`);
    const linha = linhas[0];
    if (!linha) return null;
    const telefone =
      linha.phone_enc === null
        ? null
        : await this.cipher.decryptString(tx, { tenantId, table: 'guardians', column: 'phone', rowId: responsavelId }, linha.phone_enc);
    return { telefone };
  }
}
