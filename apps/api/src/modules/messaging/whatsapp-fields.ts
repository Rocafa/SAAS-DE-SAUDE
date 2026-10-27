import type { TenantId } from '@plataforma/shared';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas do WhatsApp (migração 0032). Tabela e coluna entram no AAD (clínica + tabela + coluna
 * + id da linha): não renomear sem recifrar.
 */
export type CampoWhatsapp =
  | { readonly tabela: 'whatsapp_opt_ins'; readonly coluna: 'evidence' | 'recipient_phone' }
  | { readonly tabela: 'whatsapp_phone_keys'; readonly coluna: 'key' }
  | { readonly tabela: 'whatsapp_outbox'; readonly coluna: 'recipient_phone' | 'body' };

export const CAMPO_EVIDENCIA: CampoWhatsapp = { tabela: 'whatsapp_opt_ins', coluna: 'evidence' };
/** Número que consentiu (V1 do parecer #69). */
export const CAMPO_TELEFONE_OPTIN: CampoWhatsapp = { tabela: 'whatsapp_opt_ins', coluna: 'recipient_phone' };
/** Chave do HMAC de comparação de número (linha = id da clínica). */
export const CAMPO_CHAVE_NUMERO: CampoWhatsapp = { tabela: 'whatsapp_phone_keys', coluna: 'key' };
export const CAMPO_TELEFONE_ENVIO: CampoWhatsapp = { tabela: 'whatsapp_outbox', coluna: 'recipient_phone' };
export const CAMPO_TEXTO_ENVIO: CampoWhatsapp = { tabela: 'whatsapp_outbox', coluna: 'body' };

export function campoWhatsappRef(tenantId: TenantId, rowId: string, campo: CampoWhatsapp): FieldRef {
  return { tenantId, table: campo.tabela, column: campo.coluna, rowId };
}
