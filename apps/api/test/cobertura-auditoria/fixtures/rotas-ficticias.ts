/**
 * Controller FICTÍCIO, só para o teste de sanidade da análise de cobertura (não é registrado em módulo nenhum).
 * Cada rota exercita um caso do parecer de 03/11/2026 (R1 a R4).
 */
import { Controller, Post, Post as Escrever } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../../src/db/tenant-transaction';
import { recordAudit } from '../../../src/modules/audit/audit-log';
import type { VigilanciaDeLeituraService } from '../../../src/modules/patients/vigilancia-de-leitura';
import type { PortalVigilanciaService } from '../../../src/modules/portal/portal-vigilancia';
import { comNegacaoAuditada } from '../../../src/modules/records/acesso-clinico';
import type { TenantDatabase } from '../../../src/modules/tenancy/tenancy.module';

declare const db: TenantDatabase;
declare const tx: TenantTx;
declare const ctx: RequestContext;
declare const alvo: Parameters<typeof comNegacaoAuditada>[2];
declare const vigilancia: VigilanciaDeLeituraService;
declare const portal: PortalVigilanciaService;

@Controller('ficticio')
export class RotasFicticiasController {
  /** R1: só a negação de acesso grava; a operação não audita. Não pode contar como auditada. */
  @Post('so-negacao')
  soNegacao(): Promise<unknown> {
    return comNegacaoAuditada(db, ctx, alvo, async () => tx.execute(sql`select 1`));
  }

  /** R1: só a vigilância (anomalia) grava. Não pode contar como auditada. */
  @Post('so-vigilancia')
  async soVigilancia(): Promise<void> {
    await vigilancia.listagem(ctx);
    await portal.requisicao('conta-ficticia', null);
  }

  /** O callback da negação é seguido: a operação que audita conta. */
  @Post('negacao-com-trilha')
  negacaoComTrilha(): Promise<void> {
    return comNegacaoAuditada(db, ctx, alvo, async () => recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'ficticio' }));
  }

  /** R2: handler que só lança. */
  @Post('so-lanca')
  soLanca(): never {
    throw new Error('desligado');
  }

  /** R3: decorator renomeado no import continua sendo POST. */
  @Escrever('apelido')
  async apelido(): Promise<void> {
    await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'ficticio' });
  }

  /** R4: o SQL alcançado é coletado. */
  @Post('banco')
  async banco(): Promise<void> {
    await tx.execute(sql`select app_ficticia_grava_trilha(${1})`);
  }
}
