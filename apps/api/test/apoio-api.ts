/**
 * Apoio dos testes de API de domínio contra Postgres REAL: AppModule com sessão fictícia
 * (DevSessionProvider) e chave local (LocalKeyProvider). Dados 100% fictícios, gerados a cada execução.
 * Não é teste (sem sufixo .test.ts): é importado pelas suítes test:rls e test:security.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config';
import { tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { DevSessionProvider } from '../src/modules/auth/dev-session.provider';
import type { Perfil } from '../src/modules/auth/perfis';
import { LocalKeyProvider } from '../src/modules/crypto/local-key-provider';

export interface ApiDeTeste {
  readonly app: INestApplication;
  readonly sessoes: DevSessionProvider;
  readonly db: DatabaseHandle;
  http(): ReturnType<typeof request>;
  /** Cria uma clínica fictícia e devolve o id. */
  novaClinica(): Promise<TenantId>;
  /** Sessão fictícia: devolve o cabeçalho Authorization. */
  sessao(tenantId: TenantId, ...perfis: Perfil[]): { Authorization: string; userId: string };
  fechar(): Promise<void>;
}

export async function subirApi(): Promise<ApiDeTeste> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória');
  const sessoes = new DevSessionProvider('test');
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(loadConfig(process.env), {
        authProvider: sessoes,
        keyProvider: new LocalKeyProvider({ nodeEnv: 'test' }),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const db = createDatabase(url, { max: 2 });
  return {
    app,
    sessoes,
    db,
    http: () => request(app.getHttpServer() as Server),
    async novaClinica() {
      const id = randomUUID() as TenantId;
      await withTenant(db.db, id, async (tx) => {
        await tx.insert(tenants).values({ id, displayName: `Clinica Ficticia ${id.slice(0, 8)}` });
      });
      return id;
    },
    sessao(tenantId, ...perfis) {
      const userId = randomUUID();
      const token = sessoes.criarSessao({ tenantId, userId, perfis });
      return { Authorization: `Bearer ${token}`, userId };
    },
    async fechar() {
      await app.close();
      await db.close();
    },
  };
}

/** CPF fictício com dígitos verificadores válidos e prefixo 000 (faixa não emitida). */
export function cpfFicticio(n: number): string {
  const base = `000${String(n).padStart(6, '0')}`;
  const dv = (s: string, peso: number) => {
    let soma = 0;
    for (let i = 0; i < s.length; i++) soma += Number(s[i]) * (peso - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base, 10);
  const d2 = dv(`${base}${d1}`, 11);
  return `${base}${d1}${d2}`;
}

/** Só os cabeçalhos para o supertest (sem o userId). */
export function cab(s: { Authorization: string }): { Authorization: string } {
  return { Authorization: s.Authorization };
}
