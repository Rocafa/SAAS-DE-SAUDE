import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { installGracefulShutdown, installProcessErrorHandlers } from './lifecycle/graceful-shutdown';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  // SIGTERM/SIGINT: readiness 503 -> drena requisições -> fecha pool -> exit 0 (prazo: 25 s).
  const shutdown = installGracefulShutdown(app);
  installProcessErrorHandlers(shutdown);
  await app.listen(config.port);
  new Logger('bootstrap').log(`API ouvindo na porta ${config.port}`);
}

void bootstrap();
