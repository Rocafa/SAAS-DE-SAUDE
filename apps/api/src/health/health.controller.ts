import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  readonly status: 'ok';
}

/**
 * Liveness simples. Não toca banco nem expõe versão, ambiente ou dado algum
 * (evita fingerprinting e vazamento de informação).
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
