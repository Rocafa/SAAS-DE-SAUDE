/**
 * GUARDA DOS PAPÉIS DA IDENTIDADE (R4 do parecer do Guardião de 17/11/2026 sobre o expurgo da ativação; A1 do parecer
 * sobre a ativação do fundador). Lê o catálogo DEPOIS das migrações e falha se `app_auth` ou `app_provisionamento`
 * tiverem qualquer privilégio além da lista abaixo: GRANT de tabela, de coluna ou de função, posse de objeto, atributo
 * de papel (BYPASSRLS, SUPERUSER, INHERIT...) ou pertença a outro papel. Um GRANT novo não passa sem alguém ver.
 *
 * Pré-requisitos: migração aplicada e DATABASE_URL (qualquer papel: só lê `pg_catalog`). Não lê nem grava linha de dado.
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

/** `schema.tabela` -> privilégios de TABELA, em ordem alfabética. */
type Tabelas = Readonly<Record<string, string>>;
/** `schema.tabela.coluna` -> privilégios de COLUNA, em ordem alfabética. */
type Colunas = Readonly<Record<string, string>>;

const ESPERADO: Readonly<Record<Papel, { readonly tabelas: Tabelas; readonly colunas: Colunas; readonly funcoes: readonly string[] }>> = {
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
      // Conta existente pelo e-mail (R2) e prova da conta nascida da ativação (C3).
      'identidade.usuario.id': 'SELECT',
      'identidade.usuario.email': 'SELECT',
      'identidade.usuario.ativo': 'SELECT',
      'identidade.usuario.clinica_de_origem': 'SELECT',
    },
    // Contexto (clínica e sessão de SISTEMA, sem app_set_user), policy do portal, cadeia da trilha e prova da 0078.
    funcoes: [
      'app_audit_chain_tail(uuid)',
      'app_current_tenant()',
      'app_current_user()',
      'app_is_system_session()',
      'app_portal_patient()',
      'app_set_system_user()',
      'app_set_tenant(uuid)',
      'app_trilha_do_provisionamento(uuid,text,text,uuid)',
    ],
  },
};

let sql: postgres.Sql;

beforeAll(() => {
  sql = postgres(url, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** GRANTs diretos de tabela (qualquer relação: tabela, visão, sequência), em todos os schemas. */
async function tabelasDo(papel: Papel): Promise<Record<string, string>> {
  const linhas = await sql<{ alvo: string; p: string }[]>`
    SELECT n.nspname || '.' || c.relname AS alvo, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
     GROUP BY 1`;
  return Object.fromEntries(linhas.map((l) => [l.alvo, l.p]));
}

/** GRANTs diretos de coluna, em todos os schemas. */
async function colunasDo(papel: Papel): Promise<Record<string, string>> {
  const linhas = await sql<{ alvo: string; p: string }[]>`
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

/** GRANTs diretos de EXECUTE (fora do que vale para PUBLIC). */
async function funcoesDo(papel: Papel): Promise<string[]> {
  const linhas = await sql<{ f: string }[]>`
    SELECT p.oid::regprocedure::text AS f
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
     ORDER BY 1`;
  return linhas.map((l) => l.f).sort();
}

describe('guarda dos papéis da identidade (R4): privilégios exatos', () => {
  it('os dois papéis existem', async () => {
    const linhas = await sql<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname IN ${sql(PAPEIS)} ORDER BY 1`;
    expect(linhas.map((l) => l.rolname)).toEqual([...PAPEIS]);
  });

  for (const papel of PAPEIS) {
    it(`${papel}: GRANTs de tabela são exatamente os declarados (em qualquer schema)`, async () => {
      expect(await tabelasDo(papel)).toEqual(ESPERADO[papel].tabelas);
    });

    it(`${papel}: GRANTs de coluna são exatamente os declarados`, async () => {
      expect(await colunasDo(papel)).toEqual(ESPERADO[papel].colunas);
    });

    it(`${papel}: GRANTs de EXECUTE são exatamente os declarados`, async () => {
      expect(await funcoesDo(papel)).toEqual([...ESPERADO[papel].funcoes].sort());
    });

    it(`${papel}: sem superpoder, sem posse de objeto e sem herdar nada de outro papel`, async () => {
      const [r] = await sql<{ super: boolean; bypass: boolean; createrole: boolean; createdb: boolean; replication: boolean }[]>`
        SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole, rolcreatedb AS createdb, rolreplication AS replication
          FROM pg_roles WHERE rolname = ${papel}`;
      expect(r).toEqual({ super: false, bypass: false, createrole: false, createdb: false, replication: false });
      // Membro de nenhum papel (nem app_user, nem app_migrator): os privilégios são só os diretos acima.
      const membroDe = await sql`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${papel}`;
      expect(membroDe).toHaveLength(0);
      // Dono de nada: o dono tem todos os privilégios sem GRANT nenhum.
      const dono = await sql`
        SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
        UNION ALL SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})
        UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = ${papel})`;
      expect(dono).toHaveLength(0);
    });
  }

  it('app_provisionamento: NOINHERIT e ninguém é membro dele (a fundação pelo sistema exige o login membro, 0080)', async () => {
    const [r] = await sql<{ herda: boolean }[]>`SELECT rolinherit AS herda FROM pg_roles WHERE rolname = 'app_provisionamento'`;
    expect(r?.herda).toBe(false);
    const membros = await sql<{ rolname: string }[]>`
      SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
       WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'app_provisionamento')`;
    expect(membros).toEqual([]);
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

  it('a guarda mede algo: um GRANT a mais aparece na leitura (autoteste, desfeito no ROLLBACK)', async () => {
    const admin = process.env.DATABASE_MIGRATOR_URL;
    if (!admin) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para o autoteste da guarda');
    const mig = postgres(admin, { max: 1, onnotice: () => undefined });
    try {
      await mig
        .begin(async (tx) => {
          await tx`GRANT UPDATE (usado_em) ON identidade.ativacao_do_fundador TO app_provisionamento`;
          const [linha] = await tx<{ p: string }[]>`
            SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
              FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
             WHERE at.attrelid = 'identidade.ativacao_do_fundador'::regclass AND at.attname = 'usado_em'
               AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_provisionamento')`;
          expect(linha?.p).toBe('UPDATE');
          throw new Error('desfazer');
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== 'desfazer') throw e;
        });
    } finally {
      await mig.end({ timeout: 5 });
    }
    expect(await colunasDo('app_provisionamento')).toEqual(ESPERADO.app_provisionamento.colunas);
  });
});
