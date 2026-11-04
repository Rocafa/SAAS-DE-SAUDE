import { type DynamicModule, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { ExitWindowClosedError } from './access-policy';
import { ExportCipherMissingError, exportInTransaction, type TenantExportPackage } from './tenant-export';
import { registrarEventoDeSeguranca } from '../../security/log-de-seguranca';

export const EXIT_WINDOW_DAYS_TOKEN = Symbol('EXIT_WINDOW_DAYS');

/** Escopo da linha que registra uma exportação que caiu (R2 do parecer do #126). */
export const EXPORT_FAILED_AUDIT_SCOPE = 'tenant.full_export_failed';

/** Motivo genérico da falha: nunca a mensagem do erro, ids ou contagens (pode haver dado no texto). */
export type MotivoFalhaExportacao = 'janela_de_saida_encerrada' | 'cifra_ausente' | 'erro_interno';

export function motivoDaFalha(e: unknown): MotivoFalhaExportacao {
  if (e instanceof ExitWindowClosedError) return 'janela_de_saida_encerrada';
  if (e instanceof ExportCipherMissingError) return 'cifra_ausente';
  return 'erro_interno';
}

/**
 * Serviço de exportação (Garantia de Saída). Sem controller ainda: a rota HTTP só entra
 * junto com autenticação + RBAC/MFA (checklist LGPD item 9) — exportar exige papel de gestor.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(TenantDatabase) private readonly tenantDb: TenantDatabase,
    @Inject(EXIT_WINDOW_DAYS_TOKEN) private readonly exitWindowDays: number,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  async exportTenantData(ctx: RequestContext, now: Date = new Date()): Promise<TenantExportPackage> {
    try {
      return await this.tenantDb.run(
        ctx.tenantId,
        (tx) => exportInTransaction(tx, ctx, { now, exitWindowDays: this.exitWindowDays, cipher: this.cipher }),
        ctx.userId,
      );
    } catch (e) {
      registrarEventoDeSeguranca('EXPORTACAO_FALHOU', { tenantId: ctx.tenantId, userId: ctx.userId, motivo: motivoDaFalha(e) });
      await this.registrarFalha(ctx, motivoDaFalha(e));
      throw e;
    }
  }

  /**
   * R2 do parecer do #126: a falha fechada desfaz a transação da exportação, inclusive a linha da trilha. Esta linha
   * vai numa transação PRÓPRIA, para o DPO ver tentativa repetida ou dado corrompido. Só o motivo genérico. Se nem
   * ela grava, o erro original é que sobe (a falha da trilha vai para o log, sem dado).
   */
  private async registrarFalha(ctx: RequestContext, reason: MotivoFalhaExportacao): Promise<void> {
    try {
      await this.tenantDb.run(
        ctx.tenantId,
        (tx) => recordAudit(tx, ctx, { action: AuditAction.Export, scope: EXPORT_FAILED_AUDIT_SCOPE, metadata: { reason } }),
        ctx.userId,
      );
    } catch {
      // Só o id da clínica (UUID opaco) para correlacionar; nada da mensagem do erro (R4 do parecer do #127).
      this.logger.error(`EXPORTACAO_FALHA_NAO_AUDITADA tenant=${ctx.tenantId}`);
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { tenantId: ctx.tenantId, motivo: 'exportacao_falhou' });
    }
  }
}

@Module({})
export class ExportsModule {
  static forRoot(options: { exitWindowDays: number }): DynamicModule {
    return {
      module: ExportsModule,
      providers: [{ provide: EXIT_WINDOW_DAYS_TOKEN, useValue: options.exitWindowDays }, ExportsService],
      exports: [ExportsService],
    };
  }
}
