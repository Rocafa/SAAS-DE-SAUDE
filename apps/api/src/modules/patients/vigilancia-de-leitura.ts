/**
 * Limite por usuário e alerta de anomalia na leitura de pacientes (R5 do parecer PR #57).
 *
 * A paginação deixava recepção ou financeiro raspar a base inteira em ~1.000 chamadas, cada uma
 * auditada só com contagem. Duas defesas, contadas no MESMO store do rate limit por IP (Redis
 * compartilhado entre instâncias, com fallback em memória), mas por USUÁRIO DA SESSÃO:
 *
 * 1. Limite: no máximo `listaMax` chamadas de lista/busca (`GET /pacientes`, `POST /pacientes/busca`)
 *    por usuário a cada `listaJanelaMs`. Acima disso, 429 com `codigo: limite_por_usuario`.
 * 2. Alerta: quando o usuário passa de um padrão numa janela de `anomaliaJanelaMs`
 *    - `paginas_de_pacientes`: mais de `anomaliaPaginas` chamadas de lista/busca;
 *    - `fichas_distintas`: mais de `anomaliaFichas` fichas DISTINTAS abertas (`GET /pacientes/:id`);
 *    - `limite_por_usuario`: estourou o limite do item 1;
 *    grava UM evento `anomaly_alert` por regra e janela na trilha da clínica (ator = o usuário), com
 *    só a regra, a janela, o limiar e a contagem. Nunca id de paciente, nome ou termo de busca. Um
 *    log com marcador fixo (ALERTA_ANOMALIA, só a regra) alimenta o alarme de operação.
 *
 * As chaves dos contadores são HMAC (rateLimitKey) de clínica + usuário (+ paciente, para contar
 * fichas distintas): o store nunca vê id em claro. Store fora do ar: o FallbackRateLimitStore já cai
 * para memória; se mesmo assim falhar, a leitura segue (fail-open) com log RATE_LIMIT_FAIL_OPEN,
 * como no limite por IP.
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { rateLimitKey, type RateLimitStore } from '../../security/rate-limit-store';

export interface VigilanciaConfig {
  readonly listaMax: number;
  readonly listaJanelaMs: number;
  readonly anomaliaJanelaMs: number;
  readonly anomaliaPaginas: number;
  readonly anomaliaFichas: number;
}

export const VIGILANCIA_PADRAO: VigilanciaConfig = {
  listaMax: 60,
  listaJanelaMs: 60_000,
  anomaliaJanelaMs: 600_000,
  anomaliaPaginas: 40,
  anomaliaFichas: 40,
};

function inteiroPositivo(env: NodeJS.ProcessEnv, nome: string, padrao: number): number {
  const bruto = env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${nome} inválida: inteiro > 0`);
  return n;
}

/** Limites do ambiente (PATIENT_LIST_USER_MAX etc.); padrões em VIGILANCIA_PADRAO. */
export function loadVigilanciaConfig(env: NodeJS.ProcessEnv = process.env): VigilanciaConfig {
  return {
    listaMax: inteiroPositivo(env, 'PATIENT_LIST_USER_MAX', VIGILANCIA_PADRAO.listaMax),
    listaJanelaMs: inteiroPositivo(env, 'PATIENT_LIST_USER_WINDOW_MS', VIGILANCIA_PADRAO.listaJanelaMs),
    anomaliaJanelaMs: inteiroPositivo(env, 'PATIENT_ANOMALY_WINDOW_MS', VIGILANCIA_PADRAO.anomaliaJanelaMs),
    anomaliaPaginas: inteiroPositivo(env, 'PATIENT_ANOMALY_LIST_PAGES', VIGILANCIA_PADRAO.anomaliaPaginas),
    anomaliaFichas: inteiroPositivo(env, 'PATIENT_ANOMALY_DISTINCT_RECORDS', VIGILANCIA_PADRAO.anomaliaFichas),
  };
}

export type RegraDeAnomalia = 'paginas_de_pacientes' | 'fichas_distintas' | 'limite_por_usuario';

/** 429 por usuário. `retryAfterSeconds` vira o cabeçalho Retry-After (AllExceptionsFilter). */
export class LimitePorUsuarioError extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super({ statusCode: 429, message: 'Too Many Requests', codigo: 'limite_por_usuario' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export const VIGILANCIA_STORE = Symbol('VIGILANCIA_STORE');
export const VIGILANCIA_OPCOES = Symbol('VIGILANCIA_OPCOES');

export interface VigilanciaOpcoes {
  readonly config: VigilanciaConfig;
  readonly hashKey: Uint8Array;
  /** true quando o store foi criado para este módulo (fecha no shutdown). */
  readonly fecharStore: boolean;
}

@Injectable()
export class VigilanciaDeLeituraService implements OnApplicationShutdown {
  private readonly logger = new Logger('vigilancia');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(VIGILANCIA_STORE) private readonly store: RateLimitStore,
    @Inject(VIGILANCIA_OPCOES) private readonly opcoes: VigilanciaOpcoes,
  ) {}

  /** Lista ou busca de pacientes: limite por usuário e padrão de páginas. Lança 429 acima do limite. */
  async listagem(ctx: RequestContext): Promise<void> {
    const { config } = this.opcoes;
    const limite = await this.contar(this.chave('lista', ctx), config.listaJanelaMs);
    const paginas = await this.contar(this.chave('paginas', ctx), config.anomaliaJanelaMs);
    if (paginas && paginas.count === config.anomaliaPaginas + 1) {
      await this.alertar(ctx, 'paginas_de_pacientes', config.anomaliaJanelaMs, config.anomaliaPaginas, paginas.count);
    }
    if (limite && limite.count > config.listaMax) {
      if (limite.count === config.listaMax + 1) {
        await this.alertar(ctx, 'limite_por_usuario', config.listaJanelaMs, config.listaMax, limite.count);
      }
      throw new LimitePorUsuarioError(Math.max(1, Math.ceil(limite.resetMs / 1000)));
    }
  }

  /** Abertura de uma ficha: conta fichas DISTINTAS do usuário na janela de anomalia. */
  async ficha(ctx: RequestContext, pacienteId: string): Promise<void> {
    const { config } = this.opcoes;
    const primeiraVez = await this.contar(this.chave('ficha', ctx, pacienteId), config.anomaliaJanelaMs);
    if (!primeiraVez || primeiraVez.count !== 1) return;
    const distintas = await this.contar(this.chave('fichas', ctx), config.anomaliaJanelaMs);
    if (distintas && distintas.count === config.anomaliaFichas + 1) {
      await this.alertar(ctx, 'fichas_distintas', config.anomaliaJanelaMs, config.anomaliaFichas, distintas.count);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.opcoes.fecharStore) await this.store.close();
  }

  private chave(regra: string, ctx: RequestContext, extra = ''): string {
    // Separador 0x1f: nenhum id (UUID) contém o caractere, então as partes não se confundem.
    return rateLimitKey(`usr\u001f${regra}\u001f${ctx.tenantId}\u001f${ctx.userId}\u001f${extra}`, this.opcoes.hashKey);
  }

  private async contar(chave: string, janelaMs: number): Promise<{ count: number; resetMs: number } | undefined> {
    try {
      return await this.store.hit(chave, janelaMs);
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.error(`RATE_LIMIT_FAIL_OPEN: contador por usuário indisponível (${name}); leitura seguiu sem limite`);
      return undefined;
    }
  }

  /**
   * Evento na trilha da clínica, em transação PRÓPRIA: precisa ficar gravado mesmo quando a
   * requisição termina em 429. Só regra e números; o ator é o usuário da sessão.
   */
  private async alertar(ctx: RequestContext, regra: RegraDeAnomalia, janelaMs: number, limiar: number, contagem: number): Promise<void> {
    this.logger.warn(`ALERTA_ANOMALIA regra=${regra}`);
    try {
      await this.db.run(ctx.tenantId, (tx) =>
        recordAudit(tx, ctx, {
          action: AuditAction.AnomalyAlert,
          scope: 'patients',
          metadata: { rule: regra, window_s: Math.round(janelaMs / 1000), threshold: limiar, count: contagem },
        }),
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.error(`ALERTA_ANOMALIA_NAO_GRAVADO regra=${regra} (${name})`);
    }
  }
}
