/**
 * Limite por conta e alerta de anomalia no portal do paciente (mesmo desenho da R5 do parecer PR #57,
 * `vigilancia-de-leitura.ts`): contadores no MESMO store do rate limit (Redis compartilhado, fallback em
 * memória), com chave HMAC da conta (o store nunca vê id em claro).
 *
 * - `requisicao`: toda chamada do portal que lê ou grava dado do titular. Acima de `contaMax` por
 *   `contaJanelaMs`: 429 `limite_por_usuario` e UM `anomaly_alert` na trilha da clínica do vínculo
 *   (ator = a conta, `paciente_portal`), só com regra e números.
 * - `resgate`: tentativas de resgatar convite. Acima de `resgateMax` por `resgateJanelaMs`: 429 e log
 *   `ALERTA_ANOMALIA regra=portal_resgate` (sem clínica conhecida, não há trilha onde gravar).
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import { rateLimitKey, type RateLimitStore } from '../../security/rate-limit-store';
import { insertAudit } from '../audit/audit-log';
import { VIGILANCIA_OPCOES, VIGILANCIA_STORE, type VigilanciaOpcoes } from '../patients/vigilancia-de-leitura';
import { TenantDatabase } from '../tenancy/tenancy.module';

export interface PortalLimites {
  readonly contaMax: number;
  readonly contaJanelaMs: number;
  readonly resgateMax: number;
  readonly resgateJanelaMs: number;
}

export const PORTAL_LIMITES_PADRAO: PortalLimites = {
  contaMax: 60,
  contaJanelaMs: 60_000,
  resgateMax: 10,
  resgateJanelaMs: 900_000,
};

export const PORTAL_LIMITES = Symbol('PORTAL_LIMITES');

function inteiroPositivo(env: NodeJS.ProcessEnv, nome: string, padrao: number): number {
  const bruto = env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${nome} inválida: inteiro > 0`);
  return n;
}

export function loadPortalLimites(env: NodeJS.ProcessEnv = process.env): PortalLimites {
  return {
    contaMax: inteiroPositivo(env, 'PORTAL_ACCOUNT_MAX', PORTAL_LIMITES_PADRAO.contaMax),
    contaJanelaMs: inteiroPositivo(env, 'PORTAL_ACCOUNT_WINDOW_MS', PORTAL_LIMITES_PADRAO.contaJanelaMs),
    resgateMax: inteiroPositivo(env, 'PORTAL_REDEEM_MAX', PORTAL_LIMITES_PADRAO.resgateMax),
    resgateJanelaMs: inteiroPositivo(env, 'PORTAL_REDEEM_WINDOW_MS', PORTAL_LIMITES_PADRAO.resgateJanelaMs),
  };
}

export class LimiteDoPortalError extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super({ statusCode: 429, message: 'Too Many Requests', codigo: 'limite_por_usuario' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class PortalVigilanciaService {
  private readonly logger = new Logger('vigilancia-portal');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(VIGILANCIA_STORE) private readonly store: RateLimitStore,
    @Inject(VIGILANCIA_OPCOES) private readonly opcoes: VigilanciaOpcoes,
    @Inject(PORTAL_LIMITES) private readonly limites: PortalLimites,
  ) {}

  /** Conta a chamada; acima do limite, alerta (uma vez por janela) na clínica do vínculo e lança 429. */
  async requisicao(contaId: string, vinculoId: string | null): Promise<void> {
    const c = await this.contar(this.chave('req', contaId), this.limites.contaJanelaMs);
    if (!c || c.count <= this.limites.contaMax) return;
    if (c.count === this.limites.contaMax + 1) {
      this.logger.warn('ALERTA_ANOMALIA regra=portal_limite_por_conta');
      if (vinculoId) await this.alertar(contaId, vinculoId, c.count);
    }
    throw new LimiteDoPortalError(Math.max(1, Math.ceil(c.resetMs / 1000)));
  }

  /** Tentativa de resgate de convite (antes de qualquer consulta ao banco). */
  async resgate(contaId: string): Promise<void> {
    const c = await this.contar(this.chave('resgate', contaId), this.limites.resgateJanelaMs);
    if (!c || c.count <= this.limites.resgateMax) return;
    if (c.count === this.limites.resgateMax + 1) this.logger.warn('ALERTA_ANOMALIA regra=portal_resgate');
    throw new LimiteDoPortalError(Math.max(1, Math.ceil(c.resetMs / 1000)));
  }

  private chave(regra: string, contaId: string): string {
    return rateLimitKey(`portal\u001f${regra}\u001f${contaId}`, this.opcoes.hashKey);
  }

  private async contar(chave: string, janelaMs: number): Promise<{ count: number; resetMs: number } | undefined> {
    try {
      return await this.store.hit(chave, janelaMs);
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.error(`RATE_LIMIT_FAIL_OPEN: contador do portal indisponível (${name}); chamada seguiu sem limite`);
      return undefined;
    }
  }

  /** Em transação própria (fica gravado mesmo com a resposta 429). Só regra e números. */
  private async alertar(contaId: string, vinculoId: string, contagem: number): Promise<void> {
    try {
      await this.db.runPortal(contaId, vinculoId, async (tx) => {
        const [c] = await tx.execute<{ tenant_id: string }>(sql`select app_current_tenant() as tenant_id`);
        if (!c) return;
        await insertAudit(
          tx,
          { tenantId: c.tenant_id, actorId: contaId, actorKind: 'paciente_portal' },
          {
            action: AuditAction.AnomalyAlert,
            scope: 'portal',
            metadata: {
              rule: 'portal_limite_por_conta',
              window_s: Math.round(this.limites.contaJanelaMs / 1000),
              threshold: this.limites.contaMax,
              count: contagem,
            },
          },
        );
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.error(`ALERTA_ANOMALIA_NAO_GRAVADO regra=portal_limite_por_conta (${name})`);
    }
  }
}
