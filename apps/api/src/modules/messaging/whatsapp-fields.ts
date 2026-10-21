import type { TenantId } from '@plataforma/shared';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas do WhatsApp (migração 0032). Tabela e coluna entram no AAD (clínica + tabela + coluna
 * + id da linha): não renomear sem recifrar.
 */
export type CampoWhatsapp =
  | { readonly tabela: 'whatsapp_opt_ins'; readonly coluna: 'evidence' }
  | { readonly tabela: 'whatsapp_outbox'; readonly coluna: 'recipient_phone' | 'body' }
  | { readonly tabela: 'whatsapp_inbound'; readonly coluna: 'sender_phone' | 'body' };

export const CAMPO_EVIDENCIA: CampoWhatsapp = { tabela: 'whatsapp_opt_ins', coluna: 'evidence' };
export const CAMPO_TELEFONE_ENVIO: CampoWhatsapp = { tabela: 'whatsapp_outbox', coluna: 'recipient_phone' };
export const CAMPO_TEXTO_ENVIO: CampoWhatsapp = { tabela: 'whatsapp_outbox', coluna: 'body' };
export const CAMPO_TELEFONE_RESPOSTA: CampoWhatsapp = { tabela: 'whatsapp_inbound', coluna: 'sender_phone' };
export const CAMPO_TEXTO_RESPOSTA: CampoWhatsapp = { tabela: 'whatsapp_inbound', coluna: 'body' };

export function campoWhatsappRef(tenantId: TenantId, rowId: string, campo: CampoWhatsapp): FieldRef {
  return { tenantId, table: campo.tabela, column: campo.coluna, rowId };
}
