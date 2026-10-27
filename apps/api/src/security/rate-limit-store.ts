import { Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import Redis from 'ioredis';

/** Resultado de uma batida na janela: quantas requisições a chave já fez e quando a janela vira. */
export interface RateLimitHit {
  readonly count: number;
  /** Milissegundos até a janela atual acabar. */
  readonly resetMs: number;
}

/**
 * Modo de operação, exposto no /health/ready para o monitoramento ver a degradação:
 * - compartilhado: Redis respondendo, limite total entre as instâncias;
 * - fallback: Redis fora, contando em memória por instância até ele voltar;
 * - memoria: sem Redis (local e testes);
 * - instancia-unica: produção sem Redis, autorizada por RATE_LIMIT_ALLOW_SINGLE_INSTANCE=1.
 */
export type RateLimitMode = 'compartilhado' | 'fallback' | 'memoria' | 'instancia-unica';

/**
 * Onde os contadores do rate limit vivem. A `key` que chega aqui JÁ é derivada (rateLimitKey):
 * nenhum store recebe nem guarda IP em claro.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  mode(): RateLimitMode;
  /** Espera a conexão ficar pronta (best-effort). true = pronta; false = seguiu sem ela. */
  ready?(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Janela fixa em memória, por instância. É o fallback e o modo local/teste. Cada tamanho de janela
 * tem o próprio mapa, zerado a cada janela (o limite por IP e os limites por usuário convivem no
 * mesmo store); a memória fica limitada às chaves vistas numa janela.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<number, { start: number; hits: Map<string, number> }>();

  constructor(private readonly label: Extract<RateLimitMode, 'memoria' | 'instancia-unica'> = 'memoria') {}

  mode(): RateLimitMode {
    return this.label;
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    let w = this.windows.get(windowMs);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, hits: new Map() };
      this.windows.set(windowMs, w);
    }
    const count = (w.hits.get(key) ?? 0) + 1;
    w.hits.set(key, count);
    return Promise.resolve({ count, resetMs: w.start + windowMs - now });
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
 * IP é dado pessoal. A chave do contador é um HMAC-SHA256 do IP com segredo (RATE_LIMIT_HASH_KEY):
 * sem o segredo, não dá para montar a tabela dos ~4 bilhões de IPv4 e voltar ao IP — o que um hash
 * sem chave permitiria em minutos. Derivada UMA vez, na borda (rateLimiter); os stores só veem isto.
 */
export function rateLimitKey(clientId: string, secret: Uint8Array): string {
  return `rl:v2:${createHmac('sha256', secret).update(clientId).digest('hex').slice(0, 32)}`;
}

export const RATE_LIMIT_HASH_KEY_MIN_BYTES = 32;
let processHashKey: Buffer | undefined;

/**
 * Segredo do HMAC. Em produção é obrigatório (RATE_LIMIT_HASH_KEY, ≥ 32 bytes, vindo do Secrets
 * Manager) e o mesmo em todas as instâncias — senão cada uma contaria chaves diferentes. Fora de
 * produção, sem a variável, usa um segredo aleatório do processo (nunca IP em claro, nem em teste).
 */
export function loadRateLimitHashKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.RATE_LIMIT_HASH_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'utf8');
    if (key.length < RATE_LIMIT_HASH_KEY_MIN_BYTES) {
      throw new Error(`RATE_LIMIT_HASH_KEY precisa de ao menos ${RATE_LIMIT_HASH_KEY_MIN_BYTES} bytes`);
    }
    return key;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('RATE_LIMIT_HASH_KEY é obrigatória em produção (segredo do HMAC do rate limit)');
  }
  processHashKey ??= randomBytes(RATE_LIMIT_HASH_KEY_MIN_BYTES);
  return processHashKey;
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

  mode(): RateLimitMode {
    return 'compartilhado';
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
    const result = (await this.client.eval(HIT_SCRIPT, 1, key, windowMs)) as [number, number];
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

  mode(): RateLimitMode {
    return this.usingFallback ? 'fallback' : 'compartilhado';
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
 * só memória (local e testes). Em produção sem REDIS_URL o boot FALHA: com N instâncias o limite
 * viraria N × RATE_LIMIT_MAX sem ninguém perceber. Exceção explícita e visível no /health/ready:
 * RATE_LIMIT_ALLOW_SINGLE_INSTANCE=1 (implantação de uma instância só).
 */
export function createRateLimitStore(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    if (env.NODE_ENV === 'production') {
      if (env.RATE_LIMIT_ALLOW_SINGLE_INSTANCE !== '1') {
        throw new Error('REDIS_URL é obrigatória em produção (ou RATE_LIMIT_ALLOW_SINGLE_INSTANCE=1)');
      }
      new Logger('rate-limit').warn('produção sem Redis por opção explícita: rate limit só por instância');
      return new MemoryRateLimitStore('instancia-unica');
    }
    return new MemoryRateLimitStore();
  }
  return new FallbackRateLimitStore(new RedisRateLimitStore(url), new MemoryRateLimitStore());
}

let activeStore: RateLimitStore | undefined;

/** Registra o store em uso (applyHttpSecurity), para o /health/ready informar o modo. */
export function registerRateLimitStore(store: RateLimitStore | undefined): void {
  activeStore = store;
}

/** Modo atual do rate limit; `desligado` se nenhum store foi registrado. */
export function rateLimitMode(): RateLimitMode | 'desligado' {
  return activeStore?.mode() ?? 'desligado';
}
