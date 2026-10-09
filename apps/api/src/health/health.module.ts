import { type DynamicModule, Module } from '@nestjs/common';
import { createReadinessProbe } from '../db/readiness-probe';
import { HealthController } from './health.controller';
import { READINESS_PROBE, ReadinessController, ReadinessProbeCloser } from './readiness.controller';

export interface HealthOptions {
  readonly databaseUrl: string;
  /** Timeout total do ping de readiness (ms). */
  readonly readinessTimeoutMs?: number;
}

/**
 * `HealthModule` (estático): só liveness (`GET /health`), não toca o banco.
 * `HealthModule.forRoot(...)`: liveness + readiness (`GET /health/ready`), que checa o banco.
 */
@Module({ controllers: [HealthController] })
export class HealthModule {
  static forRoot(options: HealthOptions): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController, ReadinessController],
      providers: [
        {
          provide: READINESS_PROBE,
          useFactory: () => createReadinessProbe(options.databaseUrl, options.readinessTimeoutMs ?? 1_000),
        },
        ReadinessProbeCloser,
      ],
    };
  }
}
