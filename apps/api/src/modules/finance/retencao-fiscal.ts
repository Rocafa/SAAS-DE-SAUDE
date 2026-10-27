/**
 * Retenção fiscal do financeiro (R7 do parecer do Guardião sobre o PR #65; migração 0021).
 *
 * Política PARAMETRIZADA (`fiscal_retention_policy`, da plataforma, muda só por migração): PROPOSTA de
 * 5 anos contados de 1º/1 do ano seguinte ao pagamento — A CONFIRMAR COM O CONTADOR (perguntas 24/25;
 * `confirmadaPeloContador: false` até lá). O piso de 5 anos está no CHECK do banco.
 *
 * Vencido o prazo, `app_fiscal_retention_run()` elimina o RETRATO cifrado do recibo (nome e CPF de
 * pagador, beneficiário e emitente) e o pagador da cobrança quitada ou cancelada. Ficam número, valor,
 * forma e datas (sem dado pessoal), para a sequência dos recibos e o caixa continuarem fechando.
 * - Idempotente: só o que ainda não foi eliminado; rodar de novo dá zero.
 * - Paciente sob retenção legal (`patients.legal_hold_since`, 0017) fica intacto.
 * - Sem parâmetro de data: os triggers da 0021 conferem o prazo contra o relógio do banco, para
 *   qualquer papel (nem a função nem o runtime eliminam antes da hora).
 * Roda como job do sistema (sem usuário: sentinela da 0019) ou pela rota do admin; trilha só com contagens.
 */
import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, UseGuards } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { validarCorpoVazio } from './financeiro.validation';

export const SCOPE_RETENCAO_FISCAL = 'finance.fiscal_retention';

export interface PoliticaDeRetencaoFiscal {
  readonly anos: number;
  readonly inicio: 'primeiro_de_janeiro_do_ano_seguinte_ao_pagamento';
  /** Falso até o contador confirmar o termo inicial e o prazo. */
  readonly confirmadaPeloContador: boolean;
  readonly nota: string;
}

export interface ResultadoDaRetencaoFiscal {
  readonly recibosEliminados: number;
  readonly cobrancasEliminadas: number;
  /** 0031 (V1 do #67): retratos do responsável pagador congelados nos recebimentos. */
  readonly pagadoresEliminados: number;
  readonly politica: PoliticaDeRetencaoFiscal;
}

async function lerPolitica(tx: TenantTx): Promise<PoliticaDeRetencaoFiscal> {
  const [p] = await tx.execute<{ years: number; start_rule: string; accountant_confirmed: boolean; note: string }>(
    sql`select years, start_rule, accountant_confirmed, note from app_fiscal_retention_policy()`,
  );
  if (!p) throw new Error('política de retenção fiscal ausente');
  return {
    anos: Number(p.years),
    inicio: 'primeiro_de_janeiro_do_ano_seguinte_ao_pagamento',
    confirmadaPeloContador: p.accountant_confirmed,
    nota: p.note,
  };
}

@Injectable()
export class RetencaoFiscalService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  politica(ctx: RequestContext): Promise<PoliticaDeRetencaoFiscal> {
    return this.db.run(ctx.tenantId, (tx) => lerPolitica(tx), ctx.userId);
  }

  /** Execução pela rota (admin): o ator da trilha é o usuário da sessão. */
  executar(ctx: RequestContext): Promise<ResultadoDaRetencaoFiscal> {
    return this.db.run(ctx.tenantId, (tx) => this.naTransacao(tx, ctx), ctx.userId);
  }

  /** Execução como job do sistema (sem usuário: slot travado com o sentinela, 0019). */
  executarComoSistema(tenantId: TenantId, ctxDaTrilha: RequestContext): Promise<ResultadoDaRetencaoFiscal> {
    return this.db.run(tenantId, (tx) => this.naTransacao(tx, ctxDaTrilha));
  }

  private async naTransacao(tx: TenantTx, ctx: RequestContext): Promise<ResultadoDaRetencaoFiscal> {
    const politica = await lerPolitica(tx);
    const [r] = await tx.execute<{ receipts_purged: number; charges_purged: number; payers_purged: number }>(sql`select * from app_fiscal_retention_run()`);
    const recibosEliminados = Number(r?.receipts_purged ?? 0);
    const cobrancasEliminadas = Number(r?.charges_purged ?? 0);
    const pagadoresEliminados = Number(r?.payers_purged ?? 0);
    await recordAudit(tx, ctx, {
      action: AuditAction.Update,
      scope: SCOPE_RETENCAO_FISCAL,
      metadata: {
        op: 'fiscal_retention_run',
        receipts_purged: recibosEliminados,
        charges_purged: cobrancasEliminadas,
        payers_purged: pagadoresEliminados,
        years: politica.anos,
        accountant_confirmed: politica.confirmadaPeloContador,
      },
    });
    return { recibosEliminados, cobrancasEliminadas, pagadoresEliminados, politica };
  }
}

@Controller('financeiro/retencao-fiscal')
@UseGuards(SessaoGuard)
export class RetencaoFiscalController {
  constructor(@Inject(RetencaoFiscalService) private readonly service: RetencaoFiscalService) {}

  @Get()
  @Permissao('financeiro:configurar')
  politica(@Sessao() auth: AuthContext): Promise<PoliticaDeRetencaoFiscal> {
    return this.service.politica(paraRequestContext(auth));
  }

  @Post('execucao')
  @HttpCode(200)
  @Permissao('financeiro:configurar')
  executar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ResultadoDaRetencaoFiscal> {
    validarCorpoVazio(corpo);
    return this.service.executar(paraRequestContext(auth));
  }
}

