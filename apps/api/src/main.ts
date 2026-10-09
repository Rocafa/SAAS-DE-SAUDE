import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('bootstrap').log(`API ouvindo na porta ${config.port}`);
}

void bootstrap();
