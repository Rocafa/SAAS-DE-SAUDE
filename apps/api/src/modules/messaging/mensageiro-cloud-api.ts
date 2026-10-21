import { assinaturaHmacValida, desafioSeConfere, type MensagemDeSaida, type MensageiroWhatsApp, type ResultadoDeEnvio } from './mensageiro-whatsapp';

/**
 * ESQUELETO do adaptador da WhatsApp Business Cloud API (Meta). Desligado por padrão: só é criado por
 * `criarMensageiro` com `WHATSAPP_PROVEDOR=cloud_api` E as cláusulas-padrão da ANPD declaradas
 * (`WHATSAPP_R17_CLAUSULAS_PADRAO=assinadas`, veto do Guardião no RIPD-whatsapp §8). Sem conta Meta
 * real nesta rodada: nenhum teste chama a rede (o cliente HTTP é injetado).
 *
 * Credenciais (token de acesso, app secret, token de inscrição) vêm SÓ do ambiente/Secrets Manager e
 * nunca aparecem em log nem em erro. O envio usa mensagem de MODELO (template aprovado na Meta) com
 * parâmetros posicionais; o texto livre nunca é enviado por aqui.
 */

export interface RespostaHttp {
  readonly status: number;
  json(): Promise<unknown>;
}
export type ClienteHttp = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<RespostaHttp>;

export interface CredenciaisCloudApi {
  readonly tokenDeAcesso: string;
  readonly segredoDoApp: Buffer;
  readonly tokenInscricao: string;
  /** Versão da Graph API (ex.: v21.0). */
  readonly versaoGraph: string;
}

const BASE = 'https://graph.facebook.com';

export class MensageiroCloudApi implements MensageiroWhatsApp {
  readonly nome = 'cloud_api' as const;

  constructor(
    private readonly credenciais: CredenciaisCloudApi,
    private readonly http: ClienteHttp,
  ) {
    if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(credenciais.versaoGraph)) throw new Error('WHATSAPP_GRAPH_VERSAO inválida');
  }

  async enviar(m: MensagemDeSaida): Promise<ResultadoDeEnvio> {
    if (!/^[0-9]{5,32}$/.test(m.remetente)) return { ok: false, codigo: 'remetente_invalido', definitivo: true };
    const corpo = {
      messaging_product: 'whatsapp',
      to: m.para,
      type: 'template',
      template: {
        name: m.modelo.nomeNoProvedor,
        language: { code: m.modelo.idioma },
        components: [{ type: 'body', parameters: m.modelo.parametros.map((p) => ({ type: 'text', text: p })) }],
      },
    };
    let resposta: RespostaHttp;
    try {
      resposta = await this.http(`${BASE}/${this.credenciais.versaoGraph}/${m.remetente}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credenciais.tokenDeAcesso}`,
          'Content-Type': 'application/json',
          // Não é idempotência do provedor (a Cloud API não oferece): só correlação nos nossos registros.
          'X-Request-Id': m.idempotencia,
        },
        body: JSON.stringify(corpo),
      });
    } catch {
      return { ok: false, codigo: 'rede', definitivo: false };
    }
    const json: unknown = await resposta.json().catch(() => null);
    if (resposta.status >= 200 && resposta.status < 300) {
      const id = (json as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
      return typeof id === 'string' && id.length <= 128 ? { ok: true, idProvedor: id } : { ok: false, codigo: 'resposta_sem_id', definitivo: false };
    }
    const codigo = (json as { error?: { code?: unknown } } | null)?.error?.code;
    return {
      ok: false,
      codigo: typeof codigo === 'number' || typeof codigo === 'string' ? String(codigo).slice(0, 16) : `http_${resposta.status}`,
      // 4xx (exceto 429) não melhora repetindo; 429 e 5xx, sim.
      definitivo: resposta.status >= 400 && resposta.status < 500 && resposta.status !== 429,
    };
  }

  assinaturaValida(corpoBruto: Buffer, cabecalho: string | undefined): boolean {
    return assinaturaHmacValida(this.credenciais.segredoDoApp, corpoBruto, cabecalho);
  }

  desafioDaInscricao(modo: unknown, token: unknown, desafio: unknown): string | null {
    return desafioSeConfere(this.credenciais.tokenInscricao, modo, token, desafio);
  }
}
