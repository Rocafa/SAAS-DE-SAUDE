import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { installGracefulShutdown, installProcessErrorHandlers } from './lifecycle/graceful-shutdown';
import { createAuthProvider } from './modules/auth/auth-provider.factory';
import { bootDoBetterAuth } from './modules/auth/better-auth/boot';
import { applyHttpSecurity } from './security/http-security';
import { loadHttpSecurityConfig } from './security/http-security.config';
import { createRateLimitStore } from './security/rate-limit-store';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // REDIS_URL: rate limit compartilhado entre instâncias; sem ela, só memória (por instância).
  // O mesmo store conta por IP (borda) e por usuário (lista/busca de pacientes, R5).
  const rateLimitStore = createRateLimitStore();
  // rawBody: o webhook do WhatsApp confere o HMAC sobre os bytes EXATOS recebidos (0032).
  // D4: com AUTH_PROVIDER=better-auth, o boot monta a instância, o provedor e o handler HTTP; a fábrica decide
  // em quais ambientes o tipo sobe (só dev/test até o PR 3 da autenticação).
  const httpConfig = loadHttpSecurityConfig();
  const betterAuth = process.env.AUTH_PROVIDER === 'better-auth' ? bootDoBetterAuth(process.env, httpConfig.corsAllowedOrigins, rateLimitStore) : null;
  const authProvider = createAuthProvider(process.env, betterAuth ? { betterAuth: () => betterAuth.provider } : {});
  const app = await NestFactory.create(AppModule.forRoot(config, { rateLimitStore, authProvider }), {
    rawBody: true,
    // R2 do parecer do #132: sem os parsers padrão do Nest (que registrariam urlencoded de novo no init); a borda
    // registra só o JSON (applyHttpSecurity), que respeita o rawBody acima.
    bodyParser: false,
  });
  applyHttpSecurity(app, httpConfig, rateLimitStore, undefined, betterAuth?.montagem);
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
