import { MensageiroCloudApi, type ClienteHttp } from './mensageiro-cloud-api';
import { MensageiroFalso } from './mensageiro-falso';
import type { MensageiroWhatsApp } from './mensageiro-whatsapp';

/**
 * Escolhe o adaptador do WhatsApp no boot (WHATSAPP_PROVEDOR):
 * - vazio ou `desligado` (PADRÃO): sem canal; lembretes não saem e o webhook responde 404;
 * - `falso`: só development/test (lista fechada); segredo do webhook em WHATSAPP_APP_SECRET (base64,
 *   opcional: sem ele, todo webhook é recusado);
 * - `cloud_api`: esqueleto da Cloud API; exige as cláusulas-padrão da ANPD declaradas
 *   (WHATSAPP_R17_CLAUSULAS_PADRAO=assinadas — veto do Guardião, RIPD-whatsapp §8) e as três credenciais
 *   do ambiente, mais a conta dos modelos (WHATSAPP_WABA_ID): na subida o texto de cada modelo da
 *   plataforma é conferido na Meta (V3 do parecer #69). Faltou algo: a API NÃO sobe (erro de deploy, não canal silenciosamente quebrado).
 * Qualquer outro valor também derruba o boot.
 */
export function criarMensageiro(env: NodeJS.ProcessEnv = process.env, http?: ClienteHttp): MensageiroWhatsApp | null {
  const provedor = env.WHATSAPP_PROVEDOR ?? 'desligado';
  if (provedor === '' || provedor === 'desligado') return null;
  if (provedor === 'falso') {
    const segredo = env.WHATSAPP_APP_SECRET ? Buffer.from(env.WHATSAPP_APP_SECRET, 'base64') : undefined;
    return new MensageiroFalso({ segredoWebhook: segredo, tokenInscricao: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN, nodeEnv: env.NODE_ENV });
  }
  if (provedor === 'cloud_api') {
    if (env.WHATSAPP_R17_CLAUSULAS_PADRAO !== 'assinadas') {
      throw new Error('WhatsApp Cloud API bloqueada: cláusulas-padrão da ANPD (Res. 19/2024) não declaradas (R17 do RIPD-whatsapp)');
    }
    // WHATSAPP_WABA_ID: conta dos modelos, para conferir na subida o texto aprovado (V3 do parecer #69).
    const faltando = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_WABA_ID'].filter((k) => !env[k]);
    if (faltando.length > 0) throw new Error(`WhatsApp Cloud API sem credencial no ambiente: ${faltando.join(', ')}`);
    const cliente: ClienteHttp =
      http ??
      (async (url, init) => {
        const r = await globalThis.fetch(url, init);
        return { status: r.status, json: () => r.json() };
      });
    return new MensageiroCloudApi(
      {
        tokenDeAcesso: env.WHATSAPP_ACCESS_TOKEN ?? '',
        segredoDoApp: Buffer.from(env.WHATSAPP_APP_SECRET ?? '', 'base64'),
        tokenInscricao: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '',
        versaoGraph: env.WHATSAPP_GRAPH_VERSAO ?? 'v21.0',
        contaWaba: env.WHATSAPP_WABA_ID ?? '',
      },
      cliente,
    );
  }
  throw new Error('WHATSAPP_PROVEDOR inválido (use desligado, falso ou cloud_api)');
}
