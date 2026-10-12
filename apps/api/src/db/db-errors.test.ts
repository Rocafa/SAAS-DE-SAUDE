import { describe, expect, it } from 'vitest';
import { dbErrorCode, isTransientDatabaseError, PoolExhaustedError } from './db-errors';

/** Erro como o drizzle entrega: o erro do postgres.js fica em `cause`. */
function embrulhado(code: string): Error {
  const original = Object.assign(new Error('erro do banco'), { code });
  return new Error('Failed query: insert into "patients" ...', { cause: original });
}

describe('classificação de erros de banco', () => {
  it.each([
    ['25006', 'read_only_sql_transaction (failover / banco somente leitura)'],
    ['57P01', 'admin_shutdown'],
    ['57014', 'statement_timeout'],
    ['08006', 'connection_failure'],
    ['53300', 'too_many_connections'],
    ['25P03', 'idle_in_transaction_session_timeout'],
    ['40001', 'serialization_failure'],
    ['CONNECTION_CLOSED', 'conexão fechada (postgres.js)'],
  ])('%s (%s) é transitório: vira 503', (code) => {
    expect(isTransientDatabaseError(embrulhado(code))).toBe(true);
    expect(dbErrorCode(embrulhado(code))).toBe(code);
  });

  it.each([
    ['23505', 'unique_violation'],
    ['42501', 'insufficient_privilege (RLS/permissão)'],
    ['22P02', 'invalid_text_representation'],
    ['25001', 'active_sql_transaction (mesma classe 25, mas não é transitório)'],
  ])('%s (%s) não é transitório: vira 500', (code) => {
    expect(isTransientDatabaseError(embrulhado(code))).toBe(false);
  });

  it('erro sem código não é transitório', () => {
    expect(isTransientDatabaseError(new Error('x'))).toBe(false);
    expect(isTransientDatabaseError('texto')).toBe(false);
  });

  it('pool esgotado é transitório', () => {
    expect(isTransientDatabaseError(new PoolExhaustedError())).toBe(true);
  });
});
