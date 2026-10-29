import { createHmac, randomInt } from 'node:crypto';
import { AMBIENTES_SESSAO_FICTICIA_PORTAL } from './portal-auth';

/**
 * Código de uso único do RESGATE do convite (A2 do parecer do #68, preparo para a D4): o token do convite
 * sozinho não prova identidade (a recepção o vê; um WhatsApp encaminhado o entrega). Quem resgata precisa
 * também do código enviado ao telefone DO CADASTRO do paciente na clínica (nunca a um destino informado por
 * quem resgata). Ver migração 0033 (`app_portal_invite_challenge` / `app_portal_redeem_invite`).
 *
 * Porta plugável: `DevPortalOtpSender` (dev/test, guarda o último código em memória para os testes; não
 * loga) e, com a D4, o adaptador real (SMS/WhatsApp). Fora de development/test a API não sobe sem ele.
 */
export interface DestinoOtp {
  readonly canal: 'sms';
  /** Telefone do cadastro, só dígitos. Nunca vai para log nem para a resposta da API. */
  readonly valor: string;
}

export interface PortalOtpSender {
  readonly tipo: string;
  enviar(destino: DestinoOtp, codigo: string): Promise<void>;
}

export const PORTAL_OTP_SENDER = Symbol('PORTAL_OTP_SENDER');

/** Validade (10 min), tentativas (5) e envios por convite (5): o banco impõe os mesmos números. */
export const OTP_DIGITOS = 6;
export const OTP_CODIGO_RE = /^[0-9]{6}$/;

export function novoCodigoOtp(): string {
  return String(randomInt(0, 10 ** OTP_DIGITOS)).padStart(OTP_DIGITOS, '0');
}

/**
 * Hash do código guardado no banco: HMAC-SHA256 com o PRÓPRIO token do convite como chave. O banco não
 * guarda o token (só o SHA-256 dele), então quem lê a tabela não consegue testar os 10^6 códigos offline.
 */
export function hashDoCodigo(token: string, codigo: string): string {
  return createHmac('sha256', token).update(codigo, 'utf8').digest('hex');
}

/** Destino mascarado para a tela ("enviamos para (**) *****-1111"). */
export function mascararTelefone(digitos: string): string {
  const d = digitos.replace(/\D/g, '');
  return d.length >= 4 ? `(**) *****-${d.slice(-4)}` : '(**) *****-****';
}

/** Envio FICTÍCIO (dev/test): guarda o último código por destino, em memória. Nada sai da máquina. */
export class DevPortalOtpSender implements PortalOtpSender {
  readonly tipo = 'dev';
  private readonly ultimos = new Map<string, string>();

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (!AMBIENTES_SESSAO_FICTICIA_PORTAL.has(nodeEnv ?? '')) {
      throw new Error('DevPortalOtpSender é só para development/test: o envio real do código vem com a D4');
    }
  }

  enviar(destino: DestinoOtp, codigo: string): Promise<void> {
    this.ultimos.set(destino.valor, codigo);
    return Promise.resolve();
  }

  /** Só para testes/dev: último código enviado a este telefone (só dígitos). */
  ultimoCodigo(telefone: string): string | undefined {
    return this.ultimos.get(telefone.replace(/\D/g, ''));
  }
}

export function createPortalOtpSender(env: NodeJS.ProcessEnv = process.env): PortalOtpSender {
  if (!AMBIENTES_SESSAO_FICTICIA_PORTAL.has(env.NODE_ENV ?? '')) {
    throw new Error(`Nenhum envio real de código do portal configurado (NODE_ENV=${env.NODE_ENV ?? 'vazio'}; D4)`);
  }
  return new DevPortalOtpSender(env.NODE_ENV);
}
