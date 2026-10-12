import { Controller, Get, Inject, Injectable, type OnApplicationShutdown, Optional, Res } from '@nestjs/common';
import type { ReadinessProbe } from '../db/readiness-probe';
import { ShutdownState } from '../lifecycle/shutdown-state';
import { rateLimitMode, type RateLimitMode } from '../security/rate-limit-store';

export const READINESS_PROBE = Symbol('READINESS_PROBE');

export interface ReadinessResponse {
  readonly status: 'ok' | 'indisponivel';
  /** Modo do rate limit, para o monitoramento ver degradação (fallback, instância única, desligado). */
  readonly rateLimit: RateLimitMode | 'desligado';
}

/** Fecha a conexão da sonda no encerramento. */
@Injectable()
export class ReadinessProbeCloser implements OnApplicationShutdown {
  constructor(@Inject(READINESS_PROBE) private readonly probe: ReadinessProbe) {}

  async onApplicationShutdown(): Promise<void> {
    await this.probe.close();
  }
}

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * Readiness: a instância pode receber tráfego? Checa o banco com timeout curto.
 * 503 quando o banco não responde OU a instância está encerrando. O corpo é só `{status, rateLimit}`
 * — o modo do rate limit é um rótulo fixo; nenhum detalhe de erro, host, versão ou latência.
 */
@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(READINESS_PROBE) private readonly probe: ReadinessProbe,
    @Optional() @Inject(ShutdownState) private readonly shutdown?: ShutdownState,
  ) {}

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: StatusResponse): Promise<ReadinessResponse> {
    const ok = !this.shutdown?.isShuttingDown && (await this.probe.ping());
    if (!ok) {
      res.status(503);
      return { status: 'indisponivel', rateLimit: rateLimitMode() };
    }
    return { status: 'ok', rateLimit: rateLimitMode() };
  }
}
