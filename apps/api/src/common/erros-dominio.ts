import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExitWindowClosedError, SubscriptionWriteBlockedError } from '../modules/exports/access-policy';

/**
 * Erros de domínio com resposta HTTP GENÉRICA: código estável para o front decidir a mensagem,
 * nunca valor de campo, SQL ou detalhe interno. Registro de outra clínica (invisível pelo RLS) e
 * registro inexistente dão o mesmo 404.
 */
export class NaoEncontradoError extends NotFoundException {
  constructor() {
    super({ statusCode: 404, message: 'Não encontrado' });
  }
}

export class ConflitoError extends ConflictException {
  constructor(readonly codigo: string) {
    super({ statusCode: 409, message: 'Conflito', codigo });
  }
}

export class ProibidoError extends ForbiddenException {
  constructor(codigo?: string) {
    super({ statusCode: 403, message: 'Sem permissão', ...(codigo ? { codigo } : {}) });
  }
}

/** Traduz a política de assinatura (G1/G4) para 403 com código, sem a mensagem interna. */
export async function comPoliticaDeAssinatura<T>(operacao: Promise<T>): Promise<T> {
  try {
    return await operacao;
  } catch (e) {
    if (e instanceof SubscriptionWriteBlockedError) throw new ProibidoError('assinatura_bloqueia_escrita');
    if (e instanceof ExitWindowClosedError) throw new ProibidoError('janela_de_saida_encerrada');
    throw e;
  }
}
