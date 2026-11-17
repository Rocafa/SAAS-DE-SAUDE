/**
 * GUARDA DOS PAPÉIS DA IDENTIDADE (R4 do parecer do Guardião de 17/11/2026 sobre o expurgo da ativação; A1 do parecer
 * sobre a ativação do fundador; G1, R2 e O2 do parecer do #207). Lê o catálogo DEPOIS das migrações e falha se
 * `app_auth` ou `app_provisionamento` tiverem qualquer privilégio além da lista abaixo:
 * - GRANT DIRETO de tabela, de coluna e de função (lista exata);
 * - privilégio EFETIVO (`has_table_privilege`, `has_any_column_privilege`, `has_sequence_privilege`,
 *   `has_function_privilege`, `has_schema_privilege`, `has_database_privilege`), que soma o que vem de PUBLIC, de posse
 *   e de pertença: uma função SECURITY DEFINER nova sem `REVOKE ... FROM PUBLIC` aparece aqui;
 * - atributo de papel (BYPASSRLS, SUPERUSER, INHERIT...), posse de objeto e pertença (nos dois sentidos).
 * Um GRANT novo não passa sem alguém ver.
 *
 * Pré-requisitos: migração aplicada e DATABASE_URL (qualquer papel: só lê `pg_catalog`). Não lê nem grava linha de dado.
 * O autoteste usa DATABASE_MIGRATOR_URL dentro de transação desfeita.
 *
 * Como consertar uma falha daqui: NÃO afrouxe este arquivo sem o parecer do Guardião. Ou a migração concedeu demais,
 * ou o privilégio novo é necessário e entra abaixo, com o motivo e a migração.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL é obrigatória para a guarda dos papéis');

type Papel = 'app_auth' | 'app_provisionamento';
const PAPEIS: readonly Papel[] = ['app_auth', 'app_provisionamento'];
/** Schemas da aplicação, onde o privilégio efetivo é conferido. */
const SCHEMAS = ['public', 'identidade'] as const;

/**
 * Funções de `public` sem SECURITY DEFINER que o Postgres deixa executáveis por PUBLIC (padrão de função nova). Rodam
 * com os privilégios de quem chama, então não abrem nada; estão na lista para que uma função nova também apareça aqui.
 */
const FUNCOES_DE_PUBLIC: readonly string[] = [
  'app_fiscal_today()',
  'app_is_sealed_field(text)',
  'app_operador_nominal()',
  'app_patient_under_legal_hold(uuid,uuid)',
  'app_running_as_owner(regclass)',
  'app_specialty_looks_sensitive(text)',
  'app_whatsapp_content_retention_days()',
  'app_whatsapp_platform_templates()',
  'app_whatsapp_stuck_sending_hours()',
  'app_whatsapp_text_is_neutral(text)',
  'audit_log_canonical(audit_log)',
  'audit_metadata_ok(jsonb)',
  'portal_recalc_allowed(jsonb,jsonb,regclass)',
];

interface Esperado {
  /** `schema.tabela` -> privilégios diretos de TABELA, em ordem alfabética. */
  readonly tabelas: Readonly<Record<string, string>>;
  /** `schema.tabela.coluna` -> privilégios diretos de COLUNA. */
  readonly colunas: Readonly<Record<string, string>>;
  /** EXECUTE concedido direto ao papel. */
  readonly funcoes: readonly string[];
  /** `schema.tabela` -> privilégios EFETIVOS (tabela ou alguma coluna), em `public` e `identidade`. */
  readonly efetivas: Readonly<Record<string, string>>;
}

const ESPERADO: Readonly<Record<Papel, Esperado>> = {
  app_auth: {
    tabelas: {
      // Better Auth (0064, 0065): conta e usuário não se apagam (inativar, anonimizar).
      'identidade.usuario': 'INSERT,SELECT,UPDATE',
      'identidade.conta': 'INSERT,SELECT,UPDATE',
      'identidade.sessao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.verificacao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.dois_fatores': 'DELETE,INSERT,SELECT,UPDATE',
      // Espelhos do vínculo (0064) e do convite aceito (0073): só leitura; o convite aceito é expurgado.
      'identidade.vinculo': 'SELECT',
      'identidade.convite_aceito': 'DELETE,SELECT',
      // Recuperação (0068) e ativação do fundador (0076): DELETE só pelo expurgo de 30 dias (0070, 0079).
      'identidade.recuperacao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.ativacao_do_fundador': 'DELETE,INSERT,SELECT,UPDATE',
    },
    colunas: {},
    funcoes: [],
    efetivas: {
      'identidade.usuario': 'INSERT,SELECT,UPDATE',
      'identidade.conta': 'INSERT,SELECT,UPDATE',
      'identidade.sessao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.verificacao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.dois_fatores': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.vinculo': 'SELECT',
      'identidade.convite_aceito': 'DELETE,SELECT',
      'identidade.recuperacao': 'DELETE,INSERT,SELECT,UPDATE',
      'identidade.ativacao_do_fundador': 'DELETE,INSERT,SELECT,UPDATE',
    },
  },
  app_provisionamento: {
    tabelas: {
      // 0080: só insere a ativação (sem UPDATE nem DELETE).
      'identidade.ativacao_do_fundador': 'INSERT',
      // Clínica, vínculo e trilha, sob o RLS da clínica do contexto.
      'public.tenants': 'INSERT,SELECT',
      'public.clinic_members': 'INSERT,SELECT',
      'public.audit_log': 'INSERT,SELECT',
    },
    colunas: {
      // Repetição do pedido: só o id (nem o hash do token, nem o HMAC do e-mail).
      'identidade.ativacao_do_fundador.id': 'SELECT',
      // Prova da conta nascida da ativação (C3). Sem `email` (R1 do #207): busca e conferência só pelas funções.
      'identidade.usuario.id': 'SELECT',
      'identidade.usuario.clinica_de_origem': 'SELECT',
    },
    // Contexto (clínica e sessão de SISTEMA, sem app_set_user), policy do portal, cadeia da trilha, prova da 0078 e as
    // duas funções pela chave do e-mail (R1 do #207).
    funcoes: [
      'app_audit_chain_tail(uuid)',
      'app_current_tenant()',
      'app_current_user()',
      'app_is_system_session()',
      'app_portal_patient()',
      'app_set_system_user()',
      'app_set_tenant(uuid)',
      'app_trilha_do_provisionamento(uuid,text,text,uuid)',
      'identidade.conta_por_email(text)',
      'identidade.email_da_conta_confere(uuid,text)',
    ],
    efetivas: {
      'identidade.ativacao_do_fundador': 'INSERT,SELECT',
      'identidade.usuario': 'SELECT',
      'public.tenants': 'INSERT,SELECT',
      'public.clinic_members': 'INSERT,SELECT',
      'public.audit_log': 'INSERT,SELECT',
    },
  },
};

let sql: postgres.Sql;

beforeAll(() => {
  sql = postgres(url, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

type Leitor = postgres.Sql | postgres.TransactionSql;

/** GRANTs diretos de tabela (qualquer relação: tabela, visão, sequência), em todos os schemas. */
async function tabelasDo(db: Leitor, papel: Papel): Promise<Record<string, string>> {
  const linhas = await db<{ alvo: string; p: string }[]>`
    SELECT n.nspname || '.' || c.relname AS alvo, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
     GROUP BY 1`;
  return Object.fromEntries(linhas.map((l) => [l.alvo, l.p]));
}

/** GRANTs diretos de coluna, em todos os schemas. */
async function colunasDo(db: Leitor, papel: Papel): Promise<Record<string, string>> {
  const linhas = await db<{ alvo: string; p: string }[]>`
    SELECT n.nspname || '.' || c.relname || '.' || at.attname AS alvo,
           string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
      FROM pg_attribute at
      JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
     WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
     GROUP BY 1`;
  return Object.fromEntries(linhas.map((l) => [l.alvo, l.p]));
}

/** GRANTs diretos de EXECUTE. */
async function funcoesDo(db: Leitor, papel: Papel): Promise<string[]> {
  const linhas = await db<{ f: string }[]>`
    SELECT p.oid::regprocedure::text AS f
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${papel})`;
  return linhas.map((l) => l.f).sort();
}

/** EXECUTE EFETIVO (PUBLIC, pertença e posse incluídos) nas funções não-trigger de `public` e `identidade`. */
async function funcoesEfetivasDo(db: Leitor, papel: Papel): Promise<string[]> {
  const linhas = await db<{ f: string }[]>`
    SELECT p.oid::regprocedure::text AS f
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ${db(SCHEMAS)} AND p.prorettype <> 'trigger'::regtype
       AND has_function_privilege(${papel}, p.oid, 'EXECUTE')`;
  return linhas.map((l) => l.f).sort();
}

/** Privilégio EFETIVO em toda relação de `public` e `identidade` (tabela ou alguma coluna; sequência à parte). */
async function tabelasEfetivasDo(db: Leitor, papel: Papel): Promise<Record<string, string>> {
  const linhas = await db<{ alvo: string; p: string }[]>`
    SELECT n.nspname || '.' || c.relname AS alvo, string_agg(pr.p, ',' ORDER BY pr.p) AS p
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['SELECT', 'UPDATE', 'USAGE']
                             ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) AS pr(p)
     WHERE n.nspname IN ${db(SCHEMAS)} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(${papel}, c.oid, pr.p)
                ELSE has_table_privilege(${papel}, c.oid, pr.p)
                     OR (pr.p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(${papel}, c.oid, pr.p)) END
     GROUP BY 1`;
  return Object.fromEntries(linhas.map((l) => [l.alvo, l.p]));
}

/**
 * Pertença tolerada (O2 do #207): no RDS 16, o master que cria o papel fica membro dele com ADMIN OPTION e sem INHERIT
 * nem SET (concessão implícita ao criador). Não dá os privilégios do papel; qualquer outra linha falha.
 * N1 da reconferência: só vale para a concessão implícita, cujo concedente é o superusuário de bootstrap (no RDS, o
 * rdsadmin). Um GRANT ... WITH ADMIN OPTION feito por qualquer outro papel não é tolerado.
 */
/**
 * R3 do parecer do #208: a 0081 deixa clínica sem fundador só para o login membro de app_migrator. Os papéis do
 * runtime não podem ser membros dele, nem por cadeia (`pg_has_role` com MEMBER segue a pertença indireta).
 */
const RUNTIME = ['app_user', 'app_auth', 'app_provisionamento'] as const;
async function runtimeMembroDoMigrator(q: postgres.Sql | postgres.TransactionSql): Promise<string[]> {
  const linhas = await q<{ rolname: string }[]>`
    SELECT rolname FROM pg_roles WHERE rolname IN ${q(RUNTIME)} AND pg_has_role(oid, 'app_migrator', 'MEMBER') ORDER BY 1`;
  return linhas.map((l) => l.rolname);
}

const SO_ADMIN_DO_CRIADOR =
  'm.admin_option AND NOT m.inherit_option AND NOT m.set_option AND (SELECT g.rolsuper FROM pg_roles g WHERE g.oid = m.grantor)';

describe('guarda dos papéis da identidade (R4): privilégios diretos exatos', () => {
  it('os dois papéis existem', async () => {
    const linhas = await sql<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname IN ${sql(PAPEIS)} ORDER BY 1`;
    expect(linhas.map((l) => l.rolname)).toEqual([...PAPEIS]);
  });

  for (const papel of PAPEIS) {
    it(`${papel}: GRANTs de tabela são exatamente os declarados (em qualquer schema)`, async () => {
      expect(await tabelasDo(sql, papel)).toEqual(ESPERADO[papel].tabelas);
    });

    it(`${papel}: GRANTs de coluna são exatamente os declarados`, async () => {
      expect(await colunasDo(sql, papel)).toEqual(ESPERADO[papel].colunas);
    });

    it(`${papel}: GRANTs de EXECUTE são exatamente os declarados`, async () => {
      expect(await funcoesDo(sql, papel)).toEqual([...ESPERADO[papel].funcoes].sort());
    });
  }
});

describe('guarda dos papéis da identidade (G1): privilégio efetivo, com PUBLIC, posse e pertença', () => {
  for (const papel of PAPEIS) {
    it(`${papel}: privilégio efetivo em tabelas, visões e sequências de public e identidade é exatamente o declarado`, async () => {
      expect(await tabelasEfetivasDo(sql, papel)).toEqual(ESPERADO[papel].efetivas);
    });

    it(`${papel}: EXECUTE efetivo nas funções de public e identidade é exatamente o declarado (diretas + as de PUBLIC)`, async () => {
      expect(await funcoesEfetivasDo(sql, papel)).toEqual([...ESPERADO[papel].funcoes, ...FUNCOES_DE_PUBLIC].sort());
    });

    it(`${papel}: USAGE só em public e identidade, CREATE em nenhum schema, sem TEMPORARY nem CREATE no banco`, async () => {
      const schemas = await sql<{ nspname: string; usage: boolean; criar: boolean }[]>`
        SELECT nspname, has_schema_privilege(${papel}, oid, 'USAGE') AS usage, has_schema_privilege(${papel}, oid, 'CREATE') AS criar
          FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`;
      expect(schemas.filter((s) => s.usage).map((s) => s.nspname)).toEqual(['identidade', 'public']);
      expect(schemas.filter((s) => s.criar).map((s) => s.nspname)).toEqual([]);
      const [banco] = await sql<{ temp: boolean; criar: boolean; conectar: boolean }[]>`
        SELECT has_database_privilege(${papel}, current_database(), 'TEMPORARY') AS temp,
               has_database_privilege(${papel}, current_database(), 'CREATE') AS criar,
               has_database_privilege(${papel}, current_database(), 'CONNECT') AS conectar`;
      expect(banco).toEqual({ temp: false, criar: false, conectar: true });
    });

    it(`${papel}: sem superpoder, sem posse de objeto e sem herdar nada de outro papel`, async () => {
      const [r] = await sql<{ super: boolean; bypass: boolean; createrole: boolean; createdb: boolean; replication: boolean }[]>`
        SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole, rolcreatedb AS createdb, rolreplication AS replication
          FROM pg_roles WHERE rolname = ${papel}`;
      expect(r).toEqual({ super: false, bypass: false, createrole: false, createdb: false, replication: false });
      // Membro de nenhum papel (nem app_user, nem app_migrator): os privilégios são só os acima.
      const membroDe = await sql`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${papel}`;
      expect(membroDe).toHaveLength(0);
      // Dono de nada: o dono tem todos os privilégios sem GRANT nenhum.
      const dono = await sql`
        SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
        UNION ALL SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
        UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})`;
      expect(dono).toHaveLength(0);
    });

    it(`${papel}: ninguém é membro dele (R2), salvo o ADMIN OPTION do criador no RDS (O2)`, async () => {
      const membros = await sql<{ rolname: string }[]>`
        SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
         WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
           AND NOT (${sql.unsafe(SO_ADMIN_DO_CRIADOR)})`;
      expect(membros).toEqual([]);
    });
  }

  it('app_provisionamento: NOINHERIT (a fundação pelo sistema exige o login membro, 0080)', async () => {
    const [r] = await sql<{ herda: boolean }[]>`SELECT rolinherit AS herda FROM pg_roles WHERE rolname = 'app_provisionamento'`;
    expect(r?.herda).toBe(false);
  });

  it('R3 do #208: nenhum papel do runtime é membro de app_migrator, nem indireto (senão reabre a G3 da 0081)', async () => {
    expect(await runtimeMembroDoMigrator(sql)).toEqual([]);
  });

  it('nenhuma função SECURITY DEFINER (não-trigger) de public ou identidade é executável por PUBLIC', async () => {
    const abertas = await sql<{ f: string }[]>`
      SELECT p.oid::regprocedure::text AS f
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE n.nspname IN ${sql(SCHEMAS)} AND p.prosecdef AND p.prorettype <> 'trigger'::regtype AND a.grantee = 0`;
    expect(abertas).toEqual([]);
  });

  it('schema identidade: nenhuma tabela ou coluna concede privilégio a PUBLIC', async () => {
    const publico = await sql<{ alvo: string }[]>`
      SELECT c.relname AS alvo FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
       WHERE n.nspname = 'identidade' AND a.grantee = 0
      UNION ALL
      SELECT c.relname || '.' || at.attname FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(at.attacl) a
       WHERE n.nspname = 'identidade' AND a.grantee = 0`;
    expect(publico).toEqual([]);
  });
});

describe('guarda dos papéis: autoteste (a guarda mede algo; tudo desfeito no ROLLBACK)', () => {
  /** Roda `mexer` como app_migrator numa transação desfeita e devolve o que `ler` viu dentro dela. */
  async function dentroDeRollback<T>(
    mexer: (tx: postgres.TransactionSql) => Promise<unknown>,
    ler: (tx: postgres.TransactionSql) => Promise<T>,
    variavel: 'DATABASE_MIGRATOR_URL' | 'DATABASE_ADMIN_URL' = 'DATABASE_MIGRATOR_URL',
  ): Promise<T> {
    const admin = process.env[variavel];
    if (!admin) throw new Error(`${variavel} é obrigatória para o autoteste da guarda`);
    const mig = postgres(admin, { max: 1, onnotice: () => undefined });
    let visto: T | undefined;
    try {
      await mig
        .begin(async (tx) => {
          await mexer(tx);
          visto = await ler(tx);
          throw new Error('desfazer');
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== 'desfazer') throw e;
        });
    } finally {
      await mig.end({ timeout: 5 });
    }
    return visto as T;
  }

  it('um GRANT de coluna a mais aparece na leitura direta', async () => {
    const visto = await dentroDeRollback(
      (tx) => tx`GRANT UPDATE (usado_em) ON identidade.ativacao_do_fundador TO app_provisionamento`,
      (tx) => colunasDo(tx, 'app_provisionamento'),
    );
    expect(visto).not.toEqual(ESPERADO.app_provisionamento.colunas);
    expect(visto['identidade.ativacao_do_fundador.usado_em']).toBe('UPDATE');
    expect(await colunasDo(sql, 'app_provisionamento')).toEqual(ESPERADO.app_provisionamento.colunas);
  });

  it('GRANT EXECUTE TO PUBLIC numa função SECURITY DEFINER: a lista efetiva dos dois papéis falha, e a global também', async () => {
    const funcao = 'app_purge_discarded_private_notes()';
    const visto = await dentroDeRollback(
      (tx) => tx.unsafe(`GRANT EXECUTE ON FUNCTION ${funcao} TO PUBLIC`),
      async (tx) => ({
        prov: await funcoesEfetivasDo(tx, 'app_provisionamento'),
        auth: await funcoesEfetivasDo(tx, 'app_auth'),
        // A leitura direta NÃO vê (o GRANT é a PUBLIC): por isso a guarda confere o efetivo.
        direta: await funcoesDo(tx, 'app_provisionamento'),
      }),
    );
    expect(visto.prov).toContain(funcao);
    expect(visto.prov).not.toEqual([...ESPERADO.app_provisionamento.funcoes, ...FUNCOES_DE_PUBLIC].sort());
    expect(visto.auth).toContain(funcao);
    expect(visto.direta).toEqual([...ESPERADO.app_provisionamento.funcoes].sort());
    expect(await funcoesEfetivasDo(sql, 'app_provisionamento')).not.toContain(funcao);
  });

  it('GRANT SELECT TO PUBLIC numa tabela fora de identidade: o privilégio efetivo dos dois papéis falha', async () => {
    const visto = await dentroDeRollback(
      (tx) => tx`GRANT SELECT ON patients TO PUBLIC`,
      async (tx) => ({ prov: await tabelasEfetivasDo(tx, 'app_provisionamento'), auth: await tabelasEfetivasDo(tx, 'app_auth') }),
    );
    expect(visto.prov['public.patients']).toBe('SELECT');
    expect(visto.auth['public.patients']).toBe('SELECT');
    expect(await tabelasEfetivasDo(sql, 'app_provisionamento')).toEqual(ESPERADO.app_provisionamento.efetivas);
  });

  it('um membro novo de app_auth (com herança) falha; o ADMIN OPTION puro do criador é tolerado', async () => {
    // Pertença exige ADMIN sobre o papel: o autoteste usa o papel administrativo (DATABASE_ADMIN_URL, como no CI).
    const visto = await dentroDeRollback(
      async (tx) => {
        await tx`GRANT app_auth TO app_user`;
        // Como o master do RDS 16 recebe ao criar o papel: só ADMIN OPTION.
        await tx`GRANT app_auth TO app_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`;
      },
      (tx) => tx<{ rolname: string }[]>`
        SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
         WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'app_auth') AND NOT (${tx.unsafe(SO_ADMIN_DO_CRIADOR)})`,
      'DATABASE_ADMIN_URL',
    );
    expect(visto.map((l) => l.rolname)).toEqual(['app_user']);
  });

  it('R3 do #208: GRANT app_migrator a um papel do runtime, direto ou por cadeia, aparece na guarda', async () => {
    const visto = await dentroDeRollback(
      async (tx) => {
        await tx`GRANT app_migrator TO app_user`;
        // Por cadeia: app_auth membro de app_provisionamento, que vira membro de app_migrator.
        await tx`GRANT app_migrator TO app_provisionamento`;
        await tx`GRANT app_provisionamento TO app_auth`;
      },
      (tx) => runtimeMembroDoMigrator(tx),
      'DATABASE_ADMIN_URL',
    );
    expect(visto).toEqual(['app_auth', 'app_provisionamento', 'app_user']);
    expect(await runtimeMembroDoMigrator(sql)).toEqual([]);
  });
});
