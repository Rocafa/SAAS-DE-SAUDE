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
export function createReadinessProbe(url: string, timeoutMs = 1_000): ReadinessProbe {
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
