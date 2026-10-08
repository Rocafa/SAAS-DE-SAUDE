import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';

/**
 * Marca que a aplicação está encerrando. O Nest chama `beforeApplicationShutdown` ANTES de
 * fechar o servidor HTTP: a partir daí a readiness responde 503 (balanceador drena a instância)
 * enquanto as requisições em curso terminam.
 */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  beforeApplicationShutdown(): void {
    this.markShuttingDown();
  }
}
