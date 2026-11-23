import type { RequestContext, TenantId } from '@plataforma/shared';
import { auditLog, type AuditMetadata } from '../src/db/schema';
import type { TenantTx } from '../src/db/tenant-transaction';
import { AuditoriaIaService } from '../src/modules/audit/registro-ia';
import type { TenantDatabase } from '../src/modules/tenancy/tenancy.module';

export interface LinhaAuditoriaCapturada {
  readonly tenantId: string;
  readonly actorId: string;
  readonly actorKind: string;
  readonly action: string;
  readonly scope: string;
  readonly metadata: AuditMetadata;
}

/** Banco de unidade: mantém reais a política de assinatura, o serviço e o insertAudit; só substitui o I/O. */
export function criarAuditoriaFalsa(
  ctx: RequestContext,
  opcoes: {
    agora?: () => Date;
    monotonico?: () => number;
    falharInsert?: boolean;
    falharCommit?: boolean;
  } = {},
) {
  const linhas: LinhaAuditoriaCapturada[] = [];
  const tx = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([
                {
                  id: ctx.tenantId,
                  displayName: 'Clínica fictícia de teste',
                  subscriptionStatus: 'active',
                  cancelledAt: null,
                  createdAt: new Date('2026-01-01T00:00:00.000Z'),
                },
              ]);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      if (table !== auditLog) throw new Error('tabela inesperada no teste');
      return {
        values(row: LinhaAuditoriaCapturada) {
          if (opcoes.falharInsert) return Promise.reject(new Error('falha de auditoria de teste'));
          linhas.push(row);
          return Promise.resolve();
        },
      };
    },
  } as unknown as TenantTx;
  const db = {
    async run<T>(tenantId: TenantId, operacao: (tx: TenantTx) => Promise<T>, userId?: string): Promise<T> {
      if (tenantId !== ctx.tenantId || userId !== ctx.userId) throw new Error('contexto trocado no teste');
      const resultado = await operacao(tx);
      if (opcoes.falharCommit) throw new Error('falha de commit de teste');
      return resultado;
    },
  } as unknown as TenantDatabase;
  return {
    linhas,
    auditoria: new AuditoriaIaService(db, opcoes.agora, opcoes.monotonico),
  };
}
