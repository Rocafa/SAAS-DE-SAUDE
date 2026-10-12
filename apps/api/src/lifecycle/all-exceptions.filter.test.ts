import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AllExceptionsFilter, GENERIC_500, GENERIC_503 } from './all-exceptions.filter';

function responder() {
  const r = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    setHeader(name: string, value: string) {
      r.headers[name] = value;
      return r;
    },
    json(body: unknown) {
      r.body = body;
      return r;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => r }) } as unknown as ArgumentsHost;
  return { r, host };
}

function erroDoBanco(code: string): Error {
  return new Error('Failed query: update "patients" set ...', {
    cause: Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code }),
  });
}

describe('AllExceptionsFilter', () => {
  it('banco somente leitura (25006, failover) vira 503 genérico com Retry-After', () => {
    const { r, host } = responder();
    new AllExceptionsFilter().catch(erroDoBanco('25006'), host);
    expect(r.statusCode).toBe(503);
    expect(r.headers['Retry-After']).toBe('5');
    expect(r.body).toEqual(GENERIC_503);
  });

  it('erro não transitório vira 500 genérico, sem detalhe interno', () => {
    const { r, host } = responder();
    new AllExceptionsFilter().catch(erroDoBanco('23505'), host);
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual(GENERIC_500);
    expect(JSON.stringify(r.body)).not.toMatch(/patients|read-only|23505/);
  });
});
