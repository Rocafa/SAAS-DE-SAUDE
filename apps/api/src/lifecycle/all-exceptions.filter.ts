import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { dbErrorCode, isTransientDatabaseError } from '../db/db-errors';

/** Subconjunto da resposta do Express usado aqui (evita depender de @types/express). */
interface HttpResponse {
  readonly headersSent: boolean;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): HttpResponse;
  json(body: unknown): HttpResponse;
}

export const GENERIC_500 = { statusCode: 500, message: 'Erro interno' } as const;
export const GENERIC_503 = { statusCode: 503, message: 'Serviço temporariamente indisponível' } as const;

/**
 * Última barreira de erro HTTP:
 * - HttpException: mantém status/corpo intencionais (inclusive 4xx de validação).
 * - Banco indisponível/sobrecarregado/timeout/somente leitura (failover): 503 genérico + Retry-After.
 * - Qualquer outro erro: 500 genérico.
 * Nunca devolve stack, mensagem interna, SQL ou SQLSTATE. O log também só leva nome e código
 * (mensagens/`detail` do Postgres podem conter valores de linha, i.e. dado pessoal).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('erro');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    if (res.headersSent) return;

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const name = exception instanceof Error ? exception.name : typeof exception;
    const code = dbErrorCode(exception) ?? '-';
    if (isTransientDatabaseError(exception)) {
      this.logger.warn(`banco indisponível/lento: ${name} code=${code}`);
      res.status(HttpStatus.SERVICE_UNAVAILABLE).setHeader('Retry-After', '5').json(GENERIC_503);
      return;
    }
    this.logger.error(`erro não tratado: ${name} code=${code}`);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(GENERIC_500);
  }
}
