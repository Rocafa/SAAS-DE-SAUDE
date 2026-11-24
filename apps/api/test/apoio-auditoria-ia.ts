import type { RequestContext, TenantId } from '@plataforma/shared';
import { auditLog, type AuditMetadata } from '../src/db/schema';
import type { TenantTx } from '../src/db/tenant-transaction';
import { LocalPseudonymSigner, type PseudonymSigner } from '../src/modules/audit/ator-suporte';
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

/** Segredo fixo e fictício dos testes de unidade (32 bytes): os HMACs esperados ficam estáveis. */
export const SEGREDO_DE_TESTE_DO_MAC = Buffer.alloc(32, 7);

export function signerDeTeste(): PseudonymSigner {
  return new LocalPseudonymSigner(SEGREDO_DE_TESTE_DO_MAC, 'test');
}

/**
 * Banco de unidade: mantém reais a política de assinatura, o serviço, o signer local e o insertAudit;
 * só substitui o I/O. A leitura da trilha devolve TODAS as linhas, de todas as clínicas, como se o
 * filtro do banco falhasse: assim o teste prova também a conferência em memória do serviço.
 */
export function criarAuditoriaFalsa(
  ctx: RequestContext,
  opcoes: {
    agora?: () => Date;
    monotonico?: () => number;
    falharInsert?: boolean;
    /** Falha só o INSERT deste escopo (ex.: `ai_result`), para provar a tentativa sem resultado. */
    falharInsertDoEscopo?: string;
    falharCommit?: boolean;
    /** Status da assinatura da clínica (padrão `active`); `read_only` bloqueia escrita. */
    assinatura?: string;
    signer?: PseudonymSigner;
    linhasIniciais?: readonly LinhaAuditoriaCapturada[];
  } = {},
) {
  const linhas: LinhaAuditoriaCapturada[] = [...(opcoes.linhasIniciais ?? [])];
  const travas: string[] = [];
  // Linhas só ficam visíveis no COMMIT, como no banco: rollback descarta o que a transação inseriu.
  let pendentes: LinhaAuditoriaCapturada[] = [];
  let abertas = 0;
  const tenant = {
    id: ctx.tenantId,
    displayName: 'Clínica fictícia de teste',
    subscriptionStatus: opcoes.assinatura ?? 'active',
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const tx = {
    execute() {
      travas.push('advisory');
      return Promise.resolve([]);
    },
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return Promise.resolve(table === auditLog ? linhas.map((l) => ({ ...l })) : [tenant]);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      if (table !== auditLog) throw new Error('tabela inesperada no teste');
      return {
        values(row: LinhaAuditoriaCapturada) {
          if (opcoes.falharInsert || opcoes.falharInsertDoEscopo === row.scope) {
            return Promise.reject(new Error('falha de auditoria de teste'));
          }
          pendentes.push(row);
          return Promise.resolve();
        },
      };
    },
  } as unknown as TenantTx;
  const db = {
    async run<T>(tenantId: TenantId, operacao: (tx: TenantTx) => Promise<T>, userId?: string): Promise<T> {
      if (tenantId !== ctx.tenantId || !userId) throw new Error('contexto trocado no teste');
      abertas++;
      pendentes = [];
      try {
        const resultado = await operacao(tx);
        if (opcoes.falharCommit) throw new Error('falha de commit de teste');
        linhas.push(...pendentes);
        return resultado;
      } finally {
        pendentes = [];
        abertas--;
      }
    },
  } as unknown as TenantDatabase;
  return {
    linhas,
    travas,
    /** Transações abertas agora: o provedor tem de ver 0 (nenhuma conexão presa durante a chamada). */
    transacoesAbertas: () => abertas,
    auditoria: new AuditoriaIaService(db, opcoes.signer ?? signerDeTeste(), opcoes.agora, opcoes.monotonico),
  };
}
