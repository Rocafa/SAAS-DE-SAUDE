import { randomUUID } from 'node:crypto';
import { assinaturaHmacValida, desafioSeConfere, type MensagemDeSaida, type MensageiroWhatsApp, type ResultadoDeEnvio } from './mensageiro-whatsapp';

/**
 * Adaptador FALSO do WhatsApp: só development/test (lista fechada, como o LocalKeyProvider). Não sai
 * da memória do processo: guarda as mensagens "enviadas" para os testes conferirem o texto, e assina
 * o webhook com o mesmo HMAC da Meta, para a verificação ser exercitada de verdade.
 *
 * O segredo do webhook e o token de inscrição chegam pelo construtor (o teste gera a cada execução;
 * em dev, do ambiente). Nada fixo no código.
 */
export class MensageiroFalso implements MensageiroWhatsApp {
  readonly nome = 'falso' as const;
  readonly enviadas: { readonly mensagem: MensagemDeSaida; readonly idProvedor: string }[] = [];
  /** Números que o "provedor" recusa (para testar a falha e o fallback). */
  readonly numerosRecusados = new Set<string>();

  constructor(
    private readonly opcoes: { readonly segredoWebhook?: Buffer | undefined; readonly tokenInscricao?: string | undefined; readonly nodeEnv?: string | undefined } = {},
  ) {
    const nodeEnv = 'nodeEnv' in opcoes ? opcoes.nodeEnv : process.env.NODE_ENV;
    if (nodeEnv !== 'development' && nodeEnv !== 'test') {
      throw new Error('MensageiroFalso é só para development/test');
    }
  }

  enviar(mensagem: MensagemDeSaida): Promise<ResultadoDeEnvio> {
    if (this.numerosRecusados.has(mensagem.para)) return Promise.resolve({ ok: false, codigo: '131026', definitivo: true });
    const idProvedor = `wamid.FAKE${randomUUID().replace(/-/g, '')}`;
    this.enviadas.push({ mensagem, idProvedor });
    return Promise.resolve({ ok: true, idProvedor });
  }

  assinaturaValida(corpoBruto: Buffer, cabecalho: string | undefined): boolean {
    return assinaturaHmacValida(this.opcoes.segredoWebhook, corpoBruto, cabecalho);
  }

  desafioDaInscricao(modo: unknown, token: unknown, desafio: unknown): string | null {
    return desafioSeConfere(this.opcoes.tokenInscricao, modo, token, desafio);
  }
}
