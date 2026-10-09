import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ShutdownState } from './shutdown-state';

/** Subconjunto de `process` usado aqui (injetável para teste sem matar o runner). */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
}

export interface GracefulShutdownOptions {
  /** Prazo total para drenar requisições e fechar o pool; depois disso, saída forçada (código 1). */
  readonly timeoutMs?: number;
  readonly signals?: readonly string[];
  readonly proc?: ProcessLike;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Encerramento gracioso (substitui `enableShutdownHooks`, que re-envia o sinal ao processo):
 * 1. marca ShutdownState (readiness => 503, balanceador para de mandar tráfego);
 * 2. `app.close()`: Nest para de aceitar conexões, espera as requisições em curso terminarem
 *    e só então chama `onApplicationShutdown` (fecha o pool do banco);
 * 3. sai com código 0; se passar do prazo, sai com 1 (o orquestrador mata de qualquer jeito).
 * Retorna a função de encerramento (a mesma que os sinais disparam).
 */
export function installGracefulShutdown(
  app: INestApplicationContext,
  options: GracefulShutdownOptions = {},
): (reason: string, exitCode?: number) => Promise<void> {
  const proc = options.proc ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const logger = new Logger('shutdown');
  let pending: Promise<void> | undefined;

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (pending) return pending;
    logger.log(`encerrando (${reason})`);
    app.get(ShutdownState, { strict: false }).markShuttingDown();
    const watchdog = setTimeout(() => {
      logger.error(`encerramento excedeu ${timeoutMs} ms; saída forçada`);
      proc.exit(1);
    }, timeoutMs);
    watchdog.unref?.();
    pending = app.close().then(
      () => {
        clearTimeout(watchdog);
        logger.log('encerrado: requisições drenadas e pool fechado');
        proc.exit(exitCode);
      },
      (err: unknown) => {
        clearTimeout(watchdog);
        logger.error(`falha no encerramento: ${err instanceof Error ? err.name : typeof err}`);
        proc.exit(1);
      },
    );
    return pending;
  };

  for (const signal of options.signals ?? ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => void shutdown(signal));
  }
  return shutdown;
}

/**
 * Erros fora do ciclo de requisição:
 * - unhandledRejection: registra (só nome/código) e segue — uma promise esquecida não pode
 *   derrubar a instância inteira (o Node ≥15 encerraria o processo).
 * - uncaughtException: estado do processo é desconhecido; registra e faz encerramento gracioso
 *   com código 1 para o orquestrador substituir a instância.
 */
export function installProcessErrorHandlers(
  shutdown: (reason: string, exitCode?: number) => Promise<void>,
  proc: ProcessLike = process,
): void {
  const logger = new Logger('processo');
  const describe = (err: unknown): string => {
    const name = err instanceof Error ? err.name : typeof err;
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? `${name} code=${code}` : name;
  };
  proc.on('unhandledRejection', (reason: unknown) => {
    logger.error(`promise rejeitada sem tratamento: ${describe(reason)}`);
  });
  proc.on('uncaughtException', (err: unknown) => {
    logger.error(`exceção não capturada: ${describe(err)}`);
    void shutdown('uncaughtException', 1);
  });
}
