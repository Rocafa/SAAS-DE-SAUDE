/**
 * GUARDA DE SCHEMA — lê o catálogo do Postgres DEPOIS das migrações e falha se o banco real
 * sair do contrato de isolamento. Entra na suíte `test:rls` (include `test/**\/*.rls.test.ts`),
 * então o CI cobra o que antes era disciplina: "toda tabela nova entra no teste de isolamento".
 *
 * Pré-requisitos: migração aplicada (`pnpm db:migrate`) e DATABASE_URL = papel de runtime (app_user).
 * Não cria nem lê linha de dado nenhuma: só catálogo. Nenhum dado de paciente, real ou fictício.
 *
 * Como consertar uma falha daqui: NÃO afrouxe este arquivo. Ou a migração está incompleta
 * (falta RLS, policy ou REVOKE), ou a tabela nova precisa ser declarada abaixo E coberta por um
 * teste de `test:rls`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para a guarda de schema');

/** Papel de runtime da aplicação, criado em infra/local/postgres-init.sh. */
const RUNTIME_ROLE = 'app_user';

const PRIVILEGIOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
type Privilegio = (typeof PRIVILEGIOS)[number];

/**
 * Tabelas da APLICAÇÃO: o runtime usa e o RLS protege.
 * `privilegios` é a lista EXATA que app_user pode ter — nem mais, nem menos.
 */
const TABELAS_DA_APLICACAO: Readonly<Record<string, { readonly privilegios: readonly Privilegio[] }>> = {
  // A aplicação não exclui clínicas (migração 0001 revoga DELETE).
  tenants: { privilegios: ['SELECT', 'INSERT', 'UPDATE'] },
  patients: { privilegios: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  // Append-only (migração 0002): sem UPDATE, sem DELETE, sem TRUNCATE.
  audit_log: { privilegios: ['SELECT', 'INSERT'] },
  // Chaves por clínica (migração 0004): sem DELETE/TRUNCATE (a linha destruída fica como lápide);
  // UPDATE só nas colunas do ciclo de vida, por isso aparece via has_any_column_privilege.
  tenant_master_keys: { privilegios: ['SELECT', 'INSERT', 'UPDATE'] },
  tenant_data_keys: { privilegios: ['SELECT', 'INSERT', 'UPDATE'] },
};

/** Tabelas INTERNAS: o runtime não toca. Exigência: ZERO privilégio para app_user. */
const TABELAS_INTERNAS: Readonly<Record<string, string>> = {
  schema_migrations: 'controle de migração; scripts/migrate.mjs revoga de app_user',
  tenant_context: 'contexto de tenant travado por txid; só as funções SECURITY DEFINER acessam',
};

/** Raiz do app: o vitest roda com cwd em apps/api (vitest.rls.config.mts). */
const APP_DIR = process.cwd();
/** Diretório dos testes da suíte test:rls. */
const TEST_DIR = join(APP_DIR, 'test');
const ESTE_ARQUIVO = 'guarda-schema.rls.test.ts';

interface LinhaTabela {
  readonly tabela: string;
  readonly rls: boolean;
  readonly force: boolean;
  readonly tem_tenant_id: boolean;
}
interface LinhaPolicy {
  readonly tabela: string;
  readonly policy: string;
  readonly cmd: string;
  readonly qual: string | null;
  readonly with_check: string | null;
}
interface LinhaPublic {
  readonly tabela: string;
  readonly privilegio: string;
}

let sql: postgres.Sql;
let tabelas: readonly LinhaTabela[];
let policies: readonly LinhaPolicy[];

beforeAll(async () => {
  sql = postgres(url, { max: 1, onnotice: () => undefined });

  tabelas = await sql<LinhaTabela[]>`
    SELECT c.relname AS tabela,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force,
           EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
           ) AS tem_tenant_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`;

  policies = await sql<LinhaPolicy[]>`
    SELECT tablename AS tabela, policyname AS policy, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'`;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Privilégios que podem ser concedidos COLUNA a coluna. Para eles, `has_table_privilege`
 * responde `false` quando o GRANT é só de uma coluna — e `GRANT UPDATE (metadata) ON
 * audit_log TO app_user` já basta para furar o append-only. Por isso soma-se
 * `has_any_column_privilege`. DELETE, TRUNCATE e TRIGGER só existem no nível da tabela.
 */
const PRIVILEGIOS_POR_COLUNA = new Set<Privilegio>(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']);

/** Privilégios que o papel de runtime realmente tem na tabela, lidos do catálogo. */
async function privilegiosDoRuntime(tabela: string): Promise<Privilegio[]> {
  const concedidos: Privilegio[] = [];
  const alvo = `public.${tabela}`;
  for (const p of PRIVILEGIOS) {
    const [row] = await sql<{ tem: boolean }[]>`
      SELECT has_table_privilege(${RUNTIME_ROLE}, ${alvo}, ${p})
             OR (${PRIVILEGIOS_POR_COLUNA.has(p)}
                 AND has_any_column_privilege(${RUNTIME_ROLE}, ${alvo}, ${p})) AS tem`;
    if (row?.tem) concedidos.push(p);
  }
  return concedidos;
}

/** Fontes da suíte test:rls, exceto esta guarda. */
function fontesDaSuiteRls(): { arquivo: string; texto: string }[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.rls.test.ts') && f !== ESTE_ARQUIVO)
    .map((f) => ({ arquivo: f, texto: readFileSync(join(TEST_DIR, f), 'utf8') }));
}

/** Nome da tabela no banco -> identificador exportado em src/db/schema.ts (espelho drizzle). */
function identificadoresDoSchema(): Map<string, string> {
  const texto = readFileSync(join(APP_DIR, 'src', 'db', 'schema.ts'), 'utf8');
  const mapa = new Map<string, string>();
  for (const [, ident, tabela] of texto.matchAll(/export const (\w+) = pgTable\(\s*'([^']+)'/g)) {
    if (ident && tabela) mapa.set(tabela, ident);
  }
  return mapa;
}

describe('guarda de schema: inventário', () => {
  it('toda tabela de public está declarada como da aplicação ou como interna', () => {
    const declaradas = new Set([...Object.keys(TABELAS_DA_APLICACAO), ...Object.keys(TABELAS_INTERNAS)]);
    const naoDeclaradas = tabelas.map((t) => t.tabela).filter((t) => !declaradas.has(t));
    expect(
      naoDeclaradas,
      'tabela nova sem declaração em test/guarda-schema.rls.test.ts: declare em TABELAS_DA_APLICACAO (com os privilégios exatos de app_user) ou em TABELAS_INTERNAS (com o motivo), e cubra-a num teste de test:rls',
    ).toEqual([]);
  });

  it('toda tabela declarada existe no banco (a declaração não acumula lixo)', () => {
    const existentes = new Set(tabelas.map((t) => t.tabela));
    const declaradas = [...Object.keys(TABELAS_DA_APLICACAO), ...Object.keys(TABELAS_INTERNAS)];
    expect(declaradas.filter((t) => !existentes.has(t))).toEqual([]);
  });

  it('o banco tem as migrações aplicadas (há tabela da aplicação)', () => {
    expect(tabelas.length).toBeGreaterThan(0);
  });
});

describe('guarda de schema: RLS e policies', () => {
  for (const tabela of Object.keys(TABELAS_DA_APLICACAO)) {
    it(`${tabela}: RLS habilitado e FORÇADO`, () => {
      const t = tabelas.find((x) => x.tabela === tabela);
      expect(t, `tabela ${tabela} não existe no banco`).toBeDefined();
      expect({ rls: t?.rls, force: t?.force }).toEqual({ rls: true, force: true });
    });

    it(`${tabela}: tem pelo menos uma policy`, () => {
      expect(policies.filter((p) => p.tabela === tabela).map((p) => p.policy).length).toBeGreaterThan(0);
    });

    it(`${tabela}: privilégios de ${RUNTIME_ROLE} são exatamente os declarados`, async () => {
      const concedidos = await privilegiosDoRuntime(tabela);
      expect(concedidos.sort()).toEqual([...(TABELAS_DA_APLICACAO[tabela]?.privilegios ?? [])].sort());
    });
  }

  it('tabela interna não dá nenhum privilégio ao papel de runtime', async () => {
    for (const tabela of Object.keys(TABELAS_INTERNAS)) {
      expect(await privilegiosDoRuntime(tabela), `${tabela}: ${TABELAS_INTERNAS[tabela]}`).toEqual([]);
    }
  });

  it('audit_log continua append-only: nem UPDATE, nem DELETE, nem TRUNCATE', async () => {
    const concedidos = await privilegiosDoRuntime('audit_log');
    expect(concedidos.filter((p) => p === 'UPDATE' || p === 'DELETE' || p === 'TRUNCATE')).toEqual([]);
    const cmds = policies.filter((p) => p.tabela === 'audit_log').map((p) => p.cmd);
    // Sem policy de UPDATE/DELETE o RLS também nega essas operações (camada 3).
    expect(cmds.filter((c) => c === 'UPDATE' || c === 'DELETE' || c === 'ALL')).toEqual([]);
  });

  it('nenhuma tabela de public concede privilégio a PUBLIC, nem na tabela nem em coluna', async () => {
    const vazamentos = await sql<LinhaPublic[]>`
      SELECT c.relname AS tabela, acl.privilege_type AS privilegio
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS acl
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND acl.grantee = 0
      UNION
      -- GRANT por coluna mora em pg_attribute.attacl, não em pg_class.relacl.
      SELECT c.relname AS tabela, a.attname || ':' || acl.privilege_type AS privilegio
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped
      CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND acl.grantee = 0`;
    expect(vazamentos.map((v) => `${v.tabela}:${v.privilegio}`)).toEqual([]);
  });

  it('policy de tabela da aplicação com tenant_id usa o contexto travado, nunca a GUC', () => {
    // Só tabelas da aplicação: tenant_context também tem tenant_id, mas é interna e sua policy
    // existe para o DONO (as funções SECURITY DEFINER), não para o papel de runtime.
    const comTenant = new Set(
      tabelas.filter((t) => t.tem_tenant_id && t.tabela in TABELAS_DA_APLICACAO).map((t) => t.tabela),
    );
    const regras = policies.filter((p) => comTenant.has(p.tabela));
    expect(regras.length, 'tabela com tenant_id sem nenhuma policy').toBeGreaterThan(0);
    const ruins = regras
      .filter((p) => {
        const expr = `${p.qual ?? ''} ${p.with_check ?? ''}`;
        return expr.includes('current_setting') || !expr.includes('app_current_tenant');
      })
      .map((p) => `${p.tabela}.${p.policy}`);
    expect(
      ruins,
      'policy precisa comparar com app_current_tenant() (migração 0003); current_setting é alterável por SQL injetado',
    ).toEqual([]);
  });
});

describe('guarda de schema: cobertura no teste de isolamento', () => {
  it('toda tabela da aplicação aparece em algum teste da suíte test:rls', () => {
    const fontes = fontesDaSuiteRls();
    expect(fontes.length, 'nenhum outro teste .rls.test.ts encontrado').toBeGreaterThan(0);
    const identificadores = identificadoresDoSchema();
    const descobertas = Object.keys(TABELAS_DA_APLICACAO).filter((tabela) => {
      const ident = identificadores.get(tabela);
      const alvos = [tabela, ...(ident ? [ident] : [])];
      return !fontes.some(({ texto }) => alvos.some((alvo) => new RegExp(`\\b${alvo}\\b`).test(texto)));
    });
    expect(
      descobertas,
      'tabela da aplicação sem cobertura: escreva em test/*.rls.test.ts um teste que tente ler/gravar o dado de OUTRO tenant e falhe',
    ).toEqual([]);
  });

  it('toda tabela da aplicação tem espelho tipado em src/db/schema.ts', () => {
    const identificadores = identificadoresDoSchema();
    expect(Object.keys(TABELAS_DA_APLICACAO).filter((t) => !identificadores.has(t))).toEqual([]);
  });
});
