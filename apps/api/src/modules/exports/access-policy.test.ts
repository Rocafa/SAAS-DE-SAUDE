/**
 * GARANTIA DE SAÍDA — se este teste quebrar, alguém mudou a promessa feita às clínicas.
 * Não "conserte" o teste: a mudança precisa de aprovação do Guardião LGPD e dos sócios.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import {
  assertCanWrite,
  canExport,
  canRead,
  canWrite,
  effectiveExitWindowDays,
  EXIT_WINDOW_DAYS,
  exitWindowEndsAt,
  SUBSCRIPTION_STATUSES,
  SubscriptionWriteBlockedError,
  type SubscriptionStatus,
} from './access-policy';

const DAY = 24 * 60 * 60 * 1000;
const cancelledAt = new Date('2026-01-01T12:00:00.000Z');
const now = new Date('2026-01-02T12:00:00.000Z');
/** Inadimplente há 10 anos: não existe prazo para inadimplência. */
const muitoDepois = new Date(cancelledAt.getTime() + 3650 * DAY);

// Tabela-verdade completa por status (G1). cancelled é avaliado DENTRO da janela aqui.
const TABELA: Record<SubscriptionStatus, { write: boolean; read: boolean; exportar: boolean }> = {
  trialing: { write: true, read: true, exportar: true },
  active: { write: true, read: true, exportar: true },
  past_due: { write: false, read: true, exportar: true },
  read_only: { write: false, read: true, exportar: true },
  cancelled: { write: false, read: true, exportar: true },
};

describe('política de acesso por status de assinatura (G1)', () => {
  it('a tabela cobre exatamente todos os status existentes', () => {
    expect(Object.keys(TABELA).sort()).toEqual([...SUBSCRIPTION_STATUSES].sort());
  });

  it.each(SUBSCRIPTION_STATUSES)('%s → escrita/leitura/exportação conforme a tabela', (status) => {
    const esperado = TABELA[status];
    const cAt = status === 'cancelled' ? cancelledAt : null;
    expect(canWrite(status)).toBe(esperado.write);
    expect(canRead(status, cAt, now)).toBe(esperado.read);
    expect(canExport(status, cAt, now)).toBe(esperado.exportar);
  });

  it.each(['past_due', 'read_only'] as const)('%s → leitura e exportação SEM limite de tempo', (status) => {
    expect(canRead(status, null, muitoDepois)).toBe(true);
    expect(canExport(status, null, muitoDepois)).toBe(true);
    // Mesmo com cancelled_at preenchido por engano, o que vale é o status.
    expect(canRead(status, cancelledAt, muitoDepois)).toBe(true);
    expect(canExport(status, cancelledAt, muitoDepois)).toBe(true);
  });

  it('status bloqueados lançam erro que deixa claro que leitura/exportação seguem livres', () => {
    for (const status of ['past_due', 'read_only', 'cancelled'] as const) {
      expect(() => assertCanWrite(status)).toThrow(SubscriptionWriteBlockedError);
      expect(() => assertCanWrite(status)).toThrow(/Leitura e exportação/);
    }
    expect(() => assertCanWrite('active')).not.toThrow();
  });

  it('status desconhecido falha fechado em tudo', () => {
    const x = 'qualquer' as SubscriptionStatus;
    expect(canWrite(x)).toBe(false);
    expect(canRead(x, null, now)).toBe(false);
    expect(canExport(x, null, now)).toBe(false);
  });
});

describe('janela de saída após cancelamento (G4)', () => {
  const fim = exitWindowEndsAt(cancelledAt);

  it('padrão é 90 dias', () => {
    expect(EXIT_WINDOW_DAYS).toBe(90);
    expect(fim.getTime() - cancelledAt.getTime()).toBe(90 * DAY);
  });

  it('dentro da janela (logo após cancelar e 1 ms antes do fim) → permitido', () => {
    for (const t of [cancelledAt, now, new Date(fim.getTime() - 1)]) {
      expect(canRead('cancelled', cancelledAt, t)).toBe(true);
      expect(canExport('cancelled', cancelledAt, t)).toBe(true);
    }
  });

  it('no limite exato (cancelled_at + 90 dias) → negado', () => {
    expect(canRead('cancelled', cancelledAt, fim)).toBe(false);
    expect(canExport('cancelled', cancelledAt, fim)).toBe(false);
  });

  it('após a janela → negado', () => {
    const depois = new Date(fim.getTime() + DAY);
    expect(canRead('cancelled', cancelledAt, depois)).toBe(false);
    expect(canExport('cancelled', cancelledAt, depois)).toBe(false);
  });

  it('cancelado sem cancelled_at → negado (falha fechada; o banco já impede esse estado)', () => {
    expect(canRead('cancelled', null, now)).toBe(false);
    expect(canExport('cancelled', null, now)).toBe(false);
  });

  it('janela configurável só para CIMA: abaixo de 90 vale 90', () => {
    expect(effectiveExitWindowDays(30)).toBe(90);
    expect(effectiveExitWindowDays(Number.NaN)).toBe(90);
    expect(effectiveExitWindowDays(180)).toBe(180);
    const dia100 = new Date(cancelledAt.getTime() + 100 * DAY);
    expect(canRead('cancelled', cancelledAt, dia100, 180)).toBe(true);
    expect(canRead('cancelled', cancelledAt, new Date(fim.getTime() - 1), 30)).toBe(true);
  });

  it('EXIT_WINDOW_DAYS no ambiente: padrão 90, aceita maior, recusa menor', () => {
    const base = { DATABASE_URL: 'postgresql://ficticio@localhost/teste' };
    expect(loadConfig(base).exitWindowDays).toBe(90);
    expect(loadConfig({ ...base, EXIT_WINDOW_DAYS: '120' }).exitWindowDays).toBe(120);
    expect(() => loadConfig({ ...base, EXIT_WINDOW_DAYS: '30' })).toThrow('EXIT_WINDOW_DAYS');
    expect(() => loadConfig({ ...base, EXIT_WINDOW_DAYS: 'abc' })).toThrow('EXIT_WINDOW_DAYS');
  });
});
