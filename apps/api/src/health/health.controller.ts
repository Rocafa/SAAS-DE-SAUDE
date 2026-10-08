import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  readonly status: 'ok';
}

/**
 * Liveness: o processo está vivo e servindo HTTP? NÃO toca o banco — banco fora do ar não
 * deve fazer o orquestrador reiniciar a API em loop (isso é papel da readiness, /health/ready).
 * Não expõe versão, ambiente ou dado algum (evita fingerprinting e vazamento de informação).
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
