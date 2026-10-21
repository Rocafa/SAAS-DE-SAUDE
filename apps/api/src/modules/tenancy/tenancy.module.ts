import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  isTenantId,
  withTenant,
  type DatabaseHandle,
  type TenantTx,
} from '../../db/tenant-transaction';
import type { DatabaseTuning } from '../../db/pool-config';

export const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

/**
 * Ponto único de acesso ao banco para código de domínio: só existe `run(tenantId, fn)`,
 * então não há como consultar tabelas de tenant sem contexto definido.
 * (TenantGuard/TenantContextInterceptor vão resolver o tenantId da sessão em microparte própria.)
 */
@Injectable()
export class TenantDatabase implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  /** `userId`: usuário da sessão, travado na transação (migração 0016). */
  run<T>(tenantId: TenantId, fn: (tx: TenantTx) => Promise<T>, userId?: string): Promise<T> {
    return withTenant(this.handle.db, tenantId, fn, userId);
  }

  /**
   * Transação do PORTAL DO PACIENTE (migração 0027): `app_set_portal_session(conta, vínculo)` confere no
   * banco o vínculo ATIVO da conta e trava clínica, paciente e conta na transação (o slot do usuário fica
   * com o sentinela de sistema). Vínculo revogado ou de outra conta: 42501 (quem chama traduz). Com as
   * policies restritivas da 0027, só as linhas do próprio paciente são visíveis.
   */
  runPortal<T>(contaId: string, vinculoId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!isTenantId(contaId) || !isTenantId(vinculoId)) throw new Error('sessão do portal inválida: esperado UUID');
    return this.handle.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${contaId}::uuid, ${vinculoId}::uuid)`);
      return fn(tx);
    });
  }

  /**
   * Transação SEM contexto de clínica, só para as duas funções SECURITY DEFINER do portal que precisam
   * achar a clínica antes de haver contexto: vínculos da conta e resgate do convite (0027). Sob RLS
   * forçado nenhuma tabela da clínica é visível aqui.
   */
  semContextoDoPortal<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.handle.db.transaction(fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Module({})
export class TenancyModule {
  static forRoot(options: { databaseUrl: string; tuning?: Partial<DatabaseTuning> }): DynamicModule {
    return {
      module: TenancyModule,
      global: true,
      providers: [
        { provide: DATABASE_HANDLE, useFactory: () => createDatabase(options.databaseUrl, options.tuning) },
        TenantDatabase,
      ],
      exports: [TenantDatabase],
    };
  }
}
