import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

/** Resultado de uma batida na janela: quantas requisições a chave já fez e quando a janela vira. */
export interface RateLimitHit {
  readonly count: number;
  /** Milissegundos até a janela atual acabar. */
  readonly resetMs: number;
}

/** Onde os contadores do rate limit vivem. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  /** Espera a conexão ficar pronta (best-effort). true = pronta; false = seguiu sem ela. */
  ready?(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Janela fixa em memória, por instância. É o fallback e o modo local/teste. O mapa é zerado a
 * cada janela, então a memória fica limitada ao número de IPs vistos numa janela.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private windowStart = Date.now();
  private hits = new Map<string, number>();

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    if (now - this.windowStart >= windowMs) {
      this.windowStart = now;
      this.hits = new Map();
    }
    const count = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, count);
    return Promise.resolve({ count, resetMs: this.windowStart + windowMs - now });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * INCR + PEXPIRE atômico: a primeira batida da janela define o prazo da chave. Se a chave
 * existir sem prazo (não deveria), o prazo é recolocado para nunca virar um bloqueio eterno.
 */
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {c, t}
`;

/**
 * IP é dado pessoal: a chave no Redis leva só um hash truncado, nunca o IP em claro.
 * O hash não é segredo forte (o espaço de IPv4 é pequeno), mas a chave expira junto com a janela.
 */
export function rateLimitKey(clientId: string): string {
  return `rl:v1:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
}

export interface RedisRateLimitOptions {
  /** Prazo de cada comando; acima disso o fallback assume. */
  readonly commandTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

/** Janela fixa compartilhada entre todas as instâncias da API (ElastiCache em produção). */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: Redis;

  constructor(url: string, options: RedisRateLimitOptions = {}) {
    this.client = new Redis(url, {
      // Falha rápida: com o Redis fora, o comando erra na hora (sem fila) e o fallback assume.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: options.commandTimeoutMs ?? 100,
      connectTimeout: options.connectTimeoutMs ?? 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    // Sem listener, o ioredis registra cada erro de conexão como "Unhandled error event".
    this.client.on('error', () => undefined);
  }

  ready(timeoutMs = 2_000): Promise<boolean> {
    if (this.client.status === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.client.off('ready', onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.client.once('ready', onReady);
    });
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const result = (await this.client.eval(HIT_SCRIPT, 1, rateLimitKey(key), windowMs)) as [number, number];
    return { count: Number(result[0]), resetMs: Number(result[1]) };
  }

  close(): Promise<void> {
    this.client.disconnect();
    return Promise.resolve();
  }
}

export interface FallbackOptions {
  /** Depois de uma falha do primário, quanto tempo usar só o fallback antes de tentar de novo. */
  readonly cooldownMs?: number;
  readonly logger?: Pick<Logger, 'warn' | 'log'>;
}

/**
 * Usa o primário (Redis) e, se ele falhar ou demorar, cai para o fallback (memória) sem derrubar
 * a requisição. Depois de uma falha, fica no fallback por `cooldownMs` para não pagar o timeout
 * em toda requisição. A proteção nunca some: no pior caso, vira o limite por instância de antes.
 */
export class FallbackRateLimitStore implements RateLimitStore {
  private primaryDownUntil = 0;
  private readonly cooldownMs: number;
  private readonly logger: Pick<Logger, 'warn' | 'log'>;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
    options: FallbackOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? 5_000;
    this.logger = options.logger ?? new Logger('rate-limit');
  }

  /** true enquanto o primário está em quarentena. */
  get usingFallback(): boolean {
    return Date.now() < this.primaryDownUntil;
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    if (!this.usingFallback) {
      try {
        const result = await this.primary.hit(key, windowMs);
        if (this.primaryDownUntil !== 0) {
          this.primaryDownUntil = 0;
          this.logger.log('Redis voltou: rate limit compartilhado entre instâncias');
        }
        return result;
      } catch (err) {
        if (this.primaryDownUntil === 0) {
          const name = err instanceof Error ? err.name : typeof err;
          this.logger.warn(`Redis indisponível (${name}); rate limit em memória por ${this.cooldownMs} ms`);
        }
        this.primaryDownUntil = Date.now() + this.cooldownMs;
      }
    }
    return this.fallback.hit(key, windowMs);
  }

  ready(timeoutMs?: number): Promise<boolean> {
    return this.primary.ready?.(timeoutMs) ?? Promise.resolve(true);
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}

/**
 * Escolhe o armazenamento pelo ambiente: com REDIS_URL, Redis com fallback em memória; sem ela,
 * só memória (local e testes). Em produção sem REDIS_URL, avisa: o limite fica por instância.
 */
export function createRateLimitStore(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    if (env.NODE_ENV === 'production') {
      new Logger('rate-limit').warn('REDIS_URL ausente em produção: rate limit só por instância');
    }
    return new MemoryRateLimitStore();
  }
  return new FallbackRateLimitStore(new RedisRateLimitStore(url), new MemoryRateLimitStore());
}
