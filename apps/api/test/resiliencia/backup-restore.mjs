// BACKUP E RESTAURAÇÃO — prova de que um dump do banco volta íntegro e SEGURO.
//
// 1. semeia dados 100% fictícios (papel app_user, com contexto de tenant);
// 2. faz backup lógico (pg_dump --format=custom) e restaura em OUTRO banco (pg_restore);
// 3. roda as migrações no banco restaurado (devem ser no-op);
// 4. verifica contagens, RLS ENABLE+FORCE, policies, dono das tabelas, isolamento por tenant
//    com o papel de runtime e o append-only do audit_log (privilégio + trigger) no restaurado.
//
// Ambiente (nenhum segredo no código):
//   DATABASE_URL            papel de runtime (app_user)
//   DATABASE_MIGRATOR_URL   papel de migração (app_migrator)
//   BACKUP_ADMIN_URL        superusuário do cluster de TESTE (cria/derruba o banco restaurado, faz o dump)
//   BACKUP_METHOD           pg_dump (padrão; CI) | template (fallback LOCAL sem binários do cliente:
//                           CREATE DATABASE ... TEMPLATE — cópia física, NÃO é prova de pg_dump)
//   PG_DUMP_CMD/PG_RESTORE_CMD  comando (ex.: "docker exec -i <container> pg_dump"); padrão pg_dump/pg_restore
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const out = (msg) => process.stdout.write(`${msg}\n`);
const need = (name) => {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`${name} não definida\n`);
    process.exit(2);
  }
  return v;
};

const appUrl = need('DATABASE_URL');
const migratorUrl = need('DATABASE_MIGRATOR_URL');
const adminUrl = need('BACKUP_ADMIN_URL');
const method = process.env.BACKUP_METHOD ?? 'pg_dump';
const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const srcName = new URL(appUrl).pathname.slice(1);
const dstName = `${srcName}_restaurado`;
const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const opts = { max: 1, onnotice: () => undefined };
const TABLES = ['tenants', 'patients', 'audit_log', 'tenant_master_keys', 'tenant_data_keys'];
const failures = [];
const check = (ok, label) => {
  out(`${ok ? 'OK  ' : 'FALHA'} ${label}`);
  if (!ok) failures.push(label);
};
const sqlStateOf = async (p) =>
  p.then(
    () => 'sem-erro',
    (e) => e?.code ?? 'erro-sem-codigo',
  );

/** `command`: array [exe, ...args] ou string de linha de comando (PG_DUMP_CMD) separada por espaço. */
function run(command, args, { stdinFile, stdoutFile, env } = {}) {
  const [cmd, ...pre] = Array.isArray(command) ? command : command.split(' ').filter(Boolean);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], {
      stdio: [stdinFile ? 'pipe' : 'ignore', stdoutFile ? 'pipe' : 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    if (stdinFile) createReadStream(stdinFile).pipe(child.stdin);
    if (stdoutFile) child.stdout.pipe(createWriteStream(stdoutFile));
    else child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${cmd} saiu com ${code}: ${stderr.slice(0, 500)}`)),
    );
  });
}

/**
 * Define o tenant da transação do mesmo jeito que a aplicação: usa `app_set_tenant(uuid)` se a
 * migração que trava o contexto existir; senão, `set_config(..., true)` (escopo de transação).
 */
async function setTenant(tx, tenantId) {
  const [{ fn }] = await tx`select to_regprocedure('app_set_tenant(uuid)') is not null as fn`;
  if (fn) await tx`select app_set_tenant(${tenantId}::uuid)`;
  else await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
}

async function seed() {
  const app = postgres(appUrl, opts);
  const tenantIds = [];
  try {
    for (let t = 0; t < 3; t++) {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      tenantIds.push(id);
      await app.begin(async (tx) => {
        await setTenant(tx, id);
        await tx`insert into tenants (id, display_name) values (${id}, ${`Clinica Ficticia ${tag}`})`;
        for (let p = 0; p < 5; p++) {
          await tx`insert into patients (tenant_id, display_name) values (${id}, ${`Paciente Ficticio ${tag}-${p}`})`;
        }
        for (let a = 0; a < 2; a++) {
          await tx`insert into audit_log (tenant_id, actor_id, action, scope, metadata)
                   values (${id}, ${randomUUID()}, 'read', 'backup.verificacao', ${tx.json({ seq: a })})`;
        }
      });
    }
  } finally {
    await app.end({ timeout: 5 });
  }
  return tenantIds;
}

async function snapshot(url) {
  const db = postgres(url, opts);
  try {
    const counts = {};
    for (const t of [...TABLES, 'schema_migrations']) {
      const [{ n }] = await db.unsafe(`select count(*)::int as n from ${t}`);
      counts[t] = n;
    }
    const rls = await db`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${db(TABLES)} order by c.relname`;
    const policies = await db`
      select tablename, policyname, cmd, qual, with_check from pg_policies
      where schemaname = 'public' order by tablename, policyname`;
    const triggers = await db`
      select tgname from pg_trigger where tgrelid = 'audit_log'::regclass and not tgisinternal order by tgname`;
    return { counts, rls: [...rls], policies: [...policies], triggers: triggers.map((r) => r.tgname) };
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function main() {
  out(`== backup/restauração (${method}) de "${srcName}" para "${dstName}"`);
  const tenantIds = await seed();
  out(`dados fictícios semeados: ${tenantIds.length} tenants`);
  const before = await snapshot(adminUrl);

  const admin = postgres(withDb(adminUrl, 'postgres'), opts);
  const work = await mkdtemp(join(tmpdir(), 'backup-verif-'));
  const dumpFile = join(work, 'banco.dump');
  try {
    await admin.unsafe(`drop database if exists "${dstName}"`);
    if (method === 'pg_dump') {
      await run(process.env.PG_DUMP_CMD ?? 'pg_dump', ['--format=custom', `--dbname=${adminUrl}`], {
        stdoutFile: dumpFile,
      });
      await new Promise((r) => setTimeout(r, 200)); // flush do stream
      out(`dump gerado: ${(await stat(dumpFile)).size} bytes`);
      await admin.unsafe(`create database "${dstName}"`);
      await run(
        process.env.PG_RESTORE_CMD ?? 'pg_restore',
        ['--exit-on-error', `--dbname=${withDb(adminUrl, dstName)}`],
        { stdinFile: dumpFile },
      );
    } else if (method === 'template') {
      out('AVISO: método "template" é fallback local (cópia física), não exercita pg_dump/pg_restore.');
      await admin.unsafe(`create database "${dstName}" template "${srcName}"`);
    } else {
      throw new Error(`BACKUP_METHOD inválido: ${method}`);
    }
    // Privilégios de BANCO não fazem parte do dump: vêm da infraestrutura (postgres-init.sh/Terraform).
    await admin.unsafe(`grant connect on database "${dstName}" to app_migrator, app_user`);
    await admin.unsafe(`revoke temporary on database "${dstName}" from public`);
    out('restaurado.');

    // Migrações no restaurado: precisam ser no-op (schema_migrations veio no dump).
    const migOut = await run([process.execPath], [join(apiDir, 'scripts', 'migrate.mjs')], {
      env: { DATABASE_MIGRATOR_URL: withDb(migratorUrl, dstName) },
    });
    check(!migOut.includes('migração aplicada') && migOut.includes('migrações em dia'), 'migrações no restaurado são no-op');

    const after = await snapshot(withDb(adminUrl, dstName));
    for (const [t, n] of Object.entries(before.counts)) {
      check(after.counts[t] === n, `contagem ${t}: origem ${n} = restaurado ${after.counts[t]}`);
    }
    for (const t of TABLES) {
      const r = after.rls.find((x) => x.relname === t);
      check(Boolean(r?.relrowsecurity && r?.relforcerowsecurity), `${t}: RLS ENABLE + FORCE no restaurado`);
      check(r?.owner === 'app_migrator', `${t}: dono continua app_migrator (runtime não é dono)`);
    }
    check(JSON.stringify(after.policies) === JSON.stringify(before.policies), `policies idênticas (${after.policies.length})`);
    check(
      after.triggers.includes('audit_log_no_update_delete') && after.triggers.includes('audit_log_no_truncate'),
      'triggers append-only do audit_log presentes',
    );

    // Comportamento real com os papéis da aplicação no banco restaurado.
    const app = postgres(withDb(appUrl, dstName), opts);
    const owner = postgres(withDb(migratorUrl, dstName), opts);
    try {
      const [{ n: semContexto }] = await app`select count(*)::int as n from patients`;
      check(semContexto === 0, 'app_user sem contexto de tenant não vê nenhum paciente');
      const [a] = tenantIds;
      const vistos = await app.begin(async (tx) => {
        await setTenant(tx, a);
        return tx`select tenant_id from patients`;
      });
      check(vistos.length === 5 && vistos.every((r) => r.tenant_id === a), 'app_user com contexto vê só o próprio tenant (5)');
      const intruso = await sqlStateOf(
        app.begin(async (tx) => {
          await setTenant(tx, a);
          await tx`insert into patients (tenant_id, display_name) values (${tenantIds[1]}, 'Paciente Ficticio Intruso')`;
        }),
      );
      check(intruso === '42501', `RLS WITH CHECK bloqueia escrita em outro tenant (${intruso})`);

      const comCtx = (sql, stmt) =>
        sqlStateOf(
          sql.begin(async (tx) => {
            await setTenant(tx, a);
            await tx.unsafe(stmt);
          }),
        );
      const upd = await comCtx(app, `update audit_log set scope = 'adulterado'`);
      const del = await comCtx(app, 'delete from audit_log');
      check(upd === '42501' && del === '42501', `app_user não altera/apaga audit_log (${upd}/${del})`);
      // Dono (app_migrator) também está sob FORCE RLS: sem policy de UPDATE/DELETE, 0 linhas.
      const oUpd = await owner.unsafe(`update audit_log set scope = 'adulterado'`);
      const oDel = await owner.unsafe('delete from audit_log');
      const oTrn = await sqlStateOf(owner.unsafe('truncate audit_log'));
      check(
        oUpd.count === 0 && oDel.count === 0 && oTrn === '42501',
        `dono não altera audit_log: update/delete 0 linhas (RLS FORCE), truncate barrado (${oTrn})`,
      );
      // Papel que IGNORA RLS (superusuário do cluster de teste): o trigger é a última barreira.
      const su = postgres(withDb(adminUrl, dstName), opts);
      try {
        const sUpd = await sqlStateOf(su.unsafe(`update audit_log set scope = 'adulterado'`));
        const sDel = await sqlStateOf(su.unsafe('delete from audit_log'));
        const sTrn = await sqlStateOf(su.unsafe('truncate audit_log'));
        check(
          sUpd === '42501' && sDel === '42501' && sTrn === '42501',
          `trigger barra até superusuário: update/delete/truncate (${sUpd}/${sDel}/${sTrn})`,
        );
        const [{ n }] = await su`select count(*)::int as n from audit_log`;
        check(n === before.counts.audit_log, `audit_log intacto após as tentativas (${n})`);
      } finally {
        await su.end({ timeout: 5 });
      }
      const delTenant = await comCtx(app, 'delete from tenants');
      check(delTenant === '42501', `app_user não exclui tenants (${delTenant})`);
    } finally {
      await app.end({ timeout: 5 });
      await owner.end({ timeout: 5 });
    }
  } finally {
    if (!process.env.BACKUP_KEEP) await admin.unsafe(`drop database if exists "${dstName}" with (force)`);
    await admin.end({ timeout: 5 });
    await rm(work, { recursive: true, force: true });
  }

  if (failures.length) {
    out(`\n${failures.length} verificação(ões) falharam.`);
    process.exit(1);
  }
  out('\nbackup/restauração verificados: dados íntegros, RLS FORCE e append-only preservados.');
}

main().catch((err) => {
  process.stderr.write(`erro: ${err?.message ?? err}\n`);
  process.exit(1);
});
