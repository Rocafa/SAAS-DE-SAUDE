import postgres from 'postgres';

export interface ReadinessProbe {
  /** true se o banco respondeu `select 1` dentro do timeout. Nunca lança. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Sonda de prontidão com conexão PRÓPRIA (max 1), separada do pool de domínio: carga alta no
 * pool não derruba a readiness (evita tirar todas as instâncias do balanceador ao mesmo tempo),
 * e banco fora do ar é detectado rápido (connect_timeout curto + timeout total do ping).
 */
export function createReadinessProbe(url: string, timeoutMs = 1_000, cacheMs = 0): ReadinessProbe {
  const raw = createUncachedProbe(url, timeoutMs);
  // Proteção do banco: o endpoint de readiness não tem rate limit (ver http-security.ts), então
  // chamadas simultâneas compartilham UM ping em andamento (no máximo 1 `select 1` por vez, numa
  // conexão dedicada). `cacheMs` (padrão 0) pode guardar o resultado por um tempo, mas atrasa a
  // detecção de queda; por isso fica desligado e a queda aparece na próxima sonda.
  // Uma rajada de N requisições simultâneas vira 1 `select 1`.
  let inFlight: Promise<boolean> | null = null;
  let last: { ok: boolean; at: number } | null = null;
  return {
    ping() {
      if (last && Date.now() - last.at < cacheMs) return Promise.resolve(last.ok);
      inFlight ??= raw.ping().then((ok) => {
        last = { ok, at: Date.now() };
        inFlight = null;
        return ok;
      });
      return inFlight;
    },
    close: () => raw.close(),
  };
}

function createUncachedProbe(url: string, timeoutMs: number): ReadinessProbe {
  const client = postgres(url, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 30,
    backoff: (retries: number) => Math.min(0.05 * 2 ** retries, 1), // ver createDatabase

    onnotice: () => undefined,
    connection: { statement_timeout: timeoutMs, application_name: 'plataforma-api-readiness' },
  });
  return {
    async ping() {
      const query = client`select 1 as ok`;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        const result = await Promise.race([query.then(() => true as const), timeout]);
        if (!result) void query.cancel();
        return result;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        // A query cancelada/rejeitada não pode virar unhandledRejection.
        query.catch(() => undefined);
      }
    },
    close: () => client.end({ timeout: 2 }),
  };
}
