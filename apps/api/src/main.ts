import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { installGracefulShutdown, installProcessErrorHandlers } from './lifecycle/graceful-shutdown';
import { applyHttpSecurity } from './security/http-security';
import { createRateLimitStore } from './security/rate-limit-store';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  // REDIS_URL: rate limit compartilhado entre instâncias; sem ela, só memória (por instância).
  const rateLimitStore = createRateLimitStore();
  applyHttpSecurity(app, undefined, rateLimitStore);
  // Sem esperar, as primeiras requisições contariam só em memória (fallback) até o Redis conectar.
  if (rateLimitStore.ready && !(await rateLimitStore.ready())) {
    new Logger('rate-limit').warn('Redis não conectou no boot; começando com o fallback em memória');
  }
  // SIGTERM/SIGINT: readiness 503 -> drena requisições -> fecha pool -> exit 0 (prazo: 25 s).
  const shutdown = installGracefulShutdown(app);
  installProcessErrorHandlers(shutdown);
  await app.listen(config.port);
  new Logger('bootstrap').log(`API ouvindo na porta ${config.port}`);
}

void bootstrap();
