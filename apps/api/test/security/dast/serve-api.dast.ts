/**
 * Sobe a API real (AppModule + applyHttpSecurity, igual a main.ts) para o OWASP ZAP atacar no
 * workflow `seguranca.yml`. Roda via vitest porque, hoje, `node dist/main.js` não resolve
 * `@plataforma/shared` (pacote publicado como TypeScript-fonte) — ver testes-de-seguranca.md.
 * Fica no ar até DAST_SERVE_SECONDS (padrão 900 s) ou até o job terminar.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { it } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { loadConfig } from '../../../src/config';
import { applyHttpSecurity } from '../../../src/security/http-security';

const seconds = Number(process.env.DAST_SERVE_SECONDS ?? 900);

it('API no ar para o DAST', { timeout: (seconds + 60) * 1000 }, async () => {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config));
  applyHttpSecurity(app);
  await app.listen(config.port, '127.0.0.1');
  new Logger('dast').log(`API ouvindo em 127.0.0.1:${config.port} por ${seconds}s`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  await app.close();
});
