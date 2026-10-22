import { corpoNaMeta, type ModeloDaPlataforma } from './lembretes-regras';
import { assinaturaHmacValida, desafioSeConfere, ModeloDivergenteError, type MensagemDeSaida, type MensageiroWhatsApp, type ResultadoDeEnvio } from './mensageiro-whatsapp';

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
export type ClienteHttp = (url: string, init: { method: 'POST' | 'GET'; headers: Record<string, string>; body?: string }) => Promise<RespostaHttp>;

export interface CredenciaisCloudApi {
  readonly tokenDeAcesso: string;
  readonly segredoDoApp: Buffer;
  readonly tokenInscricao: string;
  /** Versão da Graph API (ex.: v21.0). */
  readonly versaoGraph: string;
  /** Conta do WhatsApp Business (WABA) onde os modelos estão cadastrados (identificador, não é segredo). */
  readonly contaWaba: string;
}

const BASE = 'https://graph.facebook.com';

export class MensageiroCloudApi implements MensageiroWhatsApp {
  readonly nome = 'cloud_api' as const;

  constructor(
    private readonly credenciais: CredenciaisCloudApi,
    private readonly http: ClienteHttp,
  ) {
    if (!/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(credenciais.versaoGraph)) throw new Error('WHATSAPP_GRAPH_VERSAO inválida');
    if (!/^[0-9]{5,32}$/.test(credenciais.contaWaba)) throw new Error('WHATSAPP_WABA_ID inválido');
  }

  /**
   * V3 do parecer #69: o que sai é o modelo CADASTRADO NA META pelo nome. Na subida, cada modelo da
   * plataforma é lido da Graph API e o corpo tem de ser IGUAL ao texto aprovado (com {{1}}, {{2}}...),
   * aprovado (APPROVED) e no idioma da lista. Qualquer divergência derruba a subida.
   */
  async conferirModelos(modelos: readonly ModeloDaPlataforma[]): Promise<void> {
    for (const m of modelos) {
      const url = `${BASE}/${this.credenciais.versaoGraph}/${this.credenciais.contaWaba}/message_templates?name=${encodeURIComponent(m.nomeNoProvedor)}&fields=name,language,status,components`;
      let json: unknown;
      try {
        const r = await this.http(url, { method: 'GET', headers: { Authorization: `Bearer ${this.credenciais.tokenDeAcesso}` } });
        if (r.status < 200 || r.status >= 300) throw new ModeloDivergenteError(m.nomeNoProvedor, 'consulta_falhou');
        json = await r.json();
      } catch (e) {
        if (e instanceof ModeloDivergenteError) throw e;
        throw new ModeloDivergenteError(m.nomeNoProvedor, 'consulta_falhou');
      }
      const lista = (json as { data?: unknown } | null)?.data;
      const achado = (Array.isArray(lista) ? lista : []).find(
        (t: unknown): t is { status?: unknown; components?: unknown } =>
          typeof t === 'object' && t !== null && (t as { name?: unknown }).name === m.nomeNoProvedor && (t as { language?: unknown }).language === m.idioma,
      );
      if (!achado) throw new ModeloDivergenteError(m.nomeNoProvedor, 'ausente');
      if (achado.status !== 'APPROVED') throw new ModeloDivergenteError(m.nomeNoProvedor, 'nao_aprovado');
      const corpos = (Array.isArray(achado.components) ? achado.components : []).filter(
        (c: unknown): c is { type: string; text?: unknown } => typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string',
      );
      // Só o corpo (sem cabeçalho, rodapé nem botão que possam levar outro texto).
      const outros = corpos.filter((c) => c.type.toUpperCase() !== 'BODY');
      const corpo = corpos.find((c) => c.type.toUpperCase() === 'BODY');
      if (outros.length > 0 || corpo?.text !== corpoNaMeta(m.corpo)) throw new ModeloDivergenteError(m.nomeNoProvedor, 'texto_diferente');
    }
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

  /** Texto fixo (R1 do #69) dentro da janela de 24 h de atendimento aberta pela mensagem do paciente. */
  async responderTextoFixo(m: { readonly para: string; readonly remetente: string; readonly texto: string }): Promise<ResultadoDeEnvio> {
    if (!/^[0-9]{5,32}$/.test(m.remetente) || !/^[0-9]{8,15}$/.test(m.para)) return { ok: false, codigo: 'destino_invalido', definitivo: true };
    try {
      const r = await this.http(`${BASE}/${this.credenciais.versaoGraph}/${m.remetente}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.credenciais.tokenDeAcesso}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: m.para, type: 'text', text: { body: m.texto, preview_url: false } }),
      });
      const json: unknown = await r.json().catch(() => null);
      const id = (json as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
      if (r.status >= 200 && r.status < 300 && typeof id === 'string') return { ok: true, idProvedor: id.slice(0, 128) };
      return { ok: false, codigo: `http_${r.status}`, definitivo: r.status < 500 && r.status !== 429 };
    } catch {
      return { ok: false, codigo: 'rede', definitivo: false };
    }
  }

  assinaturaValida(corpoBruto: Buffer, cabecalho: string | undefined): boolean {
    return assinaturaHmacValida(this.credenciais.segredoDoApp, corpoBruto, cabecalho);
  }

  desafioDaInscricao(modo: unknown, token: unknown, desafio: unknown): string | null {
    return desafioSeConfere(this.credenciais.tokenInscricao, modo, token, desafio);
  }
}
