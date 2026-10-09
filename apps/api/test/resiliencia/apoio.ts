/**
 * Apoio dos testes de resiliência: app Nest real (AppModule) + rotas só de teste.
 * Dados 100% fictícios gerados a cada execução. Nenhuma credencial aqui: URLs vêm do ambiente.
 */
import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  type INestApplication,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { count, sql } from 'drizzle-orm';
import { AppModule } from '../../src/app.module';
import type { AppConfig } from '../../src/config';
import { DEFAULT_DATABASE_TUNING, type DatabaseTuning } from '../../src/db/pool-config';
import { patients, tenants } from '../../src/db/schema';
import { createDatabase, withTenant } from '../../src/db/tenant-transaction';
import { TenantDatabase } from '../../src/modules/tenancy/tenancy.module';

export function urlDoAmbiente(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para os testes de resiliência');
  return url;
}

/** Rotas de TESTE (não existem na aplicação): exercitam o banco via TenantDatabase. */
@Controller('__teste')
class RotasDeTesteController {
  constructor(@Inject(TenantDatabase) private readonly tenantDb: TenantDatabase) {}

  @Get('pacientes/:tenantId')
  async pacientes(@Param('tenantId') tenantId: string): Promise<{ total: number }> {
    const [row] = await this.tenantDb.run(tenantId as TenantId, (tx) =>
      tx.select({ total: count() }).from(patients),
    );
    return { total: row?.total ?? 0 };
  }

  /** Segura uma conexão por `ms` (pg_sleep) — simula requisição longa/consulta lenta. */
  @Get('sono/:tenantId')
  async sono(
    @Param('tenantId') tenantId: string,
    @Query('ms', ParseIntPipe) ms: number,
  ): Promise<{ status: 'ok' }> {
    await this.tenantDb.run(tenantId as TenantId, (tx) => tx.execute(sql`select pg_sleep(${ms / 1000})`));
    return { status: 'ok' };
  }

  /** Erro de programação com mensagem "interna" e stack: não pode aparecer na resposta. */
  @Get('explode')
  explode(): never {
    throw new Error('DETALHE-INTERNO-NAO-PODE-VAZAR em /srv/app/segredo.ts:42');
  }

  /** Erro NÃO transitório do Postgres (sintaxe): 500 genérico, sem SQL nem SQLSTATE. */
  @Get('sql-invalido/:tenantId')
  async sqlInvalido(@Param('tenantId') tenantId: string): Promise<never> {
    await this.tenantDb.run(tenantId as TenantId, (tx) => tx.execute(sql.raw('selec DETALHE_SQL_INTERNO')));
    throw new Error('inalcançável');
  }

  @Get('nao-encontrado')
  naoEncontrado(): never {
    throw new NotFoundException();
  }
}

@Module({ controllers: [RotasDeTesteController] })
class RotasDeTesteModule {}

export async function criarApp(databaseUrl: string, tuning: Partial<DatabaseTuning> = {}): Promise<INestApplication> {
  const config: AppConfig = {
    port: 0,
    databaseUrl,
    exitWindowDays: 90,
    database: { ...DEFAULT_DATABASE_TUNING, ...tuning },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config), RotasDeTesteModule],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

export function baseUrl(app: INestApplication): string {
  const addr = (app.getHttpServer() as import('node:http').Server).address() as import('node:net').AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

/** Cria um tenant fictício com N pacientes fictícios (conexão direta, sem proxy). */
export async function semearTenant(nPacientes = 2): Promise<TenantId> {
  const h = createDatabase(urlDoAmbiente(), { max: 1 });
  const tenantId = randomUUID() as TenantId;
  const tag = tenantId.slice(0, 8);
  try {
    await withTenant(h.db, tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, displayName: `Clinica Ficticia ${tag}` });
      for (let i = 0; i < nPacientes; i++) {
        await tx.insert(patients).values({ tenantId, displayName: `Paciente Ficticio ${tag}-${i}` });
      }
    });
  } finally {
    await h.close();
  }
  return tenantId;
}

export async function esperarAte(cond: () => Promise<boolean>, prazoMs: number, passoMs = 200): Promise<number> {
  const inicio = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - inicio;
    if (Date.now() - inicio > prazoMs) throw new Error(`condição não atendida em ${prazoMs} ms`);
    await new Promise((r) => setTimeout(r, passoMs));
  }
}

/** Garante que nenhuma resposta de erro carrega stack, caminho, SQL ou mensagem interna. */
export function semVazamento(corpo: string): void {
  for (const proibido of ['stack', 'at ', '.ts:', 'DETALHE', 'selec', 'SQLSTATE', 'postgres', '42601', 'ECONN']) {
    if (corpo.includes(proibido)) throw new Error(`resposta vazou "${proibido}": ${corpo}`);
  }
}
