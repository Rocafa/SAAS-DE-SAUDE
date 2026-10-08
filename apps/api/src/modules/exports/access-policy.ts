/**
 * GARANTIA DE SAÍDA — política de acesso por status de assinatura (pura, sem I/O).
 * Ver docs/04-arquitetura/garantia-de-saida.md. Os testes em access-policy.test.ts quebram
 * o CI se alguém fizer inadimplência bloquear leitura/exportação ou encurtar a janela de saída.
 *
 * Regra: o status de assinatura NÃO restringe leitura/exportação, exceto após a janela de
 * saída; RBAC/MFA continuam valendo à parte (esta política trata só do eixo "assinatura").
 *
 * - trialing, active        → leitura, exportação e escrita.
 * - past_due, read_only     → leitura e exportação SEM limite de tempo; escrita bloqueada (G1).
 * - cancelled               → leitura e exportação SOMENTE dentro da janela de saída
 *                             [cancelled_at, cancelled_at + EXIT_WINDOW_DAYS); escrita bloqueada.
 *                             No instante exato do fim da janela, o acesso já é negado (G4).
 *                             Após a janela, os dados seguem o DPA (eliminação NÃO implementada
 *                             aqui); a guarda legal do prontuário (20 anos) é da clínica.
 * - status desconhecido ou cancelled sem cancelled_at → negado (falha fechada; o banco impede
 *   cancelled sem data pelo CHECK tenants_cancelled_at_check).
 */
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '../../db/schema';

export { SUBSCRIPTION_STATUSES, type SubscriptionStatus };

/** G4: janela de saída padrão e PISO. Configurável só para cima (EXIT_WINDOW_DAYS no ambiente). */
export const EXIT_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Status que permitem criar/alterar registros clínicos e operacionais. */
const WRITABLE: ReadonlySet<string> = new Set<SubscriptionStatus>(['trialing', 'active']);
/** Status em que leitura/exportação não têm limite de tempo (inadimplência inclusa). */
const READABLE_WITHOUT_LIMIT: ReadonlySet<string> = new Set<SubscriptionStatus>([
  'trialing',
  'active',
  'past_due',
  'read_only',
]);

/** Janela efetiva: nunca menor que o piso de 90 dias, mesmo que configurada errada. */
export function effectiveExitWindowDays(days: number = EXIT_WINDOW_DAYS): number {
  return Number.isFinite(days) ? Math.max(Math.floor(days), EXIT_WINDOW_DAYS) : EXIT_WINDOW_DAYS;
}

/** Fim (exclusivo) da janela de saída de um tenant cancelado. */
export function exitWindowEndsAt(cancelledAt: Date, days: number = EXIT_WINDOW_DAYS): Date {
  return new Date(cancelledAt.getTime() + effectiveExitWindowDays(days) * DAY_MS);
}

export function isWithinExitWindow(cancelledAt: Date, now: Date, days: number = EXIT_WINDOW_DAYS): boolean {
  return now.getTime() < exitWindowEndsAt(cancelledAt, days).getTime();
}

/** Escrita: só trialing/active. Falha fechada para qualquer outro valor. */
export function canWrite(status: SubscriptionStatus): boolean {
  return WRITABLE.has(status);
}

/** Leitura: livre por status, exceto cancelled fora da janela de saída. */
export function canRead(
  status: SubscriptionStatus,
  cancelledAt: Date | null,
  now: Date,
  windowDays: number = EXIT_WINDOW_DAYS,
): boolean {
  if (READABLE_WITHOUT_LIMIT.has(status)) return true;
  if (status === 'cancelled') return cancelledAt !== null && isWithinExitWindow(cancelledAt, now, windowDays);
  return false;
}

/** Exportação (gratuita): mesma regra da leitura — a saída nunca é mais restrita que a leitura. */
export function canExport(
  status: SubscriptionStatus,
  cancelledAt: Date | null,
  now: Date,
  windowDays: number = EXIT_WINDOW_DAYS,
): boolean {
  return canRead(status, cancelledAt, now, windowDays);
}

export class SubscriptionWriteBlockedError extends Error {
  constructor(readonly status: SubscriptionStatus) {
    super(
      `Assinatura em "${status}": novos registros estão bloqueados. ` +
        'Leitura e exportação dos dados continuam disponíveis.',
    );
    this.name = 'SubscriptionWriteBlockedError';
  }
}

export class ExitWindowClosedError extends Error {
  constructor() {
    super('A janela de saída após o cancelamento terminou: leitura e exportação não estão mais disponíveis.');
    this.name = 'ExitWindowClosedError';
  }
}

export function assertCanWrite(status: SubscriptionStatus): void {
  if (!canWrite(status)) throw new SubscriptionWriteBlockedError(status);
}
