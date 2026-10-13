/**
 * G2 — a exportação cobre TODAS as tabelas da clínica. Lê o catálogo do Postgres (como a guarda de
 * schema) e reprova se uma tabela com tenant_id, ou uma coluna de tabela exportada, não estiver no
 * pacote nem na lista de exclusões com motivo. Depois exporta uma clínica fictícia completa pela
 * aplicação real (mesma cifra da API) e confere conteúdo, contagens, CSV e auditoria.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantId, UserId } from '@plataforma/shared';
import { auditLog, patients, professionals, appointmentTypes, appointments } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { UTF8_BOM } from '../src/modules/exports/csv';
import { ExportsService } from '../src/modules/exports/exports.module';
import {
  EXPORT_AUDIT_SCOPE,
  EXPORT_EXCLUDED_TABLES,
  EXPORT_SCHEMA_VERSION,
  EXPORTED_TABLES,
  exportTenantData,
  ExportCipherMissingError,
  type TenantExportPackage,
} from '../src/modules/exports/tenant-export';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória');

/** Tabela exportada -> chave em data/counts do pacote. */
const CHAVE_NO_PACOTE: Readonly<Record<(typeof EXPORTED_TABLES)[number], string>> = {
  tenants: 'tenant',
  patients: 'patients',
  professionals: 'professionals',
  appointment_types: 'appointmentTypes',
  appointments: 'appointments',
};

/** Colunas que, de propósito, não viram campo do item exportado (com o motivo). */
const COLUNAS_FORA_DO_ITEM: Readonly<Record<string, string>> = {
  'tenants.subscription_status': 'vai no manifesto (subscription.status)',
  'tenants.cancelled_at': 'vai no manifesto (subscription.cancelledAt)',
  'patients.search_name': 'derivada do nome para a busca (não é dado próprio)',
};

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

let sqlCat: postgres.Sql;
let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let pkg: TenantExportPackage;
const FORMULA = '=HYPERLINK("http://exemplo.test")';

beforeAll(async () => {
  sqlCat = postgres(url, { max: 1, onnotice: () => undefined });
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  const admin = api.sessao(clinicaA, 'admin', 'profissional');
  const prof = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticia', especialidade: 'TO' });
  const tipo = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Avaliacao', minutos: 40 });
  const pac = await api
    .http()
    .post('/pacientes')
    .set(cab(admin))
    .send({ nome: 'Paciente Ficticia Export', nomeSocial: FORMULA, cpf: cpfFicticio(7), telefone: '11900000007', nascimento: '2001-01-02' });
  expect(pac.status).toBe(201);
  await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio Dois', telefone: '1133330000' }).expect(201);
  const ag = await api.http().post('/agendamentos').set(cab(admin)).send({
    pacienteId: (pac.body as { id: string }).id,
    profissionalId: (prof.body as { id: string }).id,
    tipoId: (tipo.body as { id: string }).id,
    data: '2030-05-06',
    hora: '08:00',
  });
  expect(ag.status).toBe(201);
  // Clínica B com dados próprios, que não podem aparecer no pacote de A.
  const adminB = api.sessao(clinicaB, 'admin');
  await api.http().post('/pacientes').set(cab(adminB)).send({ nome: 'Paciente Ficticio Outra Clinica', telefone: '11900000008' }).expect(201);
  await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof B', especialidade: 'Psico' }).expect(201);

  const ctx = { tenantId: clinicaA, userId: admin.userId as UserId, roles: ['admin'] };
  pkg = await api.app.get(ExportsService).exportTenantData(ctx);
});

afterAll(async () => {
  await sqlCat?.end({ timeout: 5 });
  await api?.fechar();
});

describe('G2 — cobertura da exportação contra o catálogo', () => {
  it('toda tabela com tenant_id está no pacote ou excluída com motivo (e nunca nos dois)', async () => {
    const rows = await sqlCat<{ tabela: string }[]>`
      SELECT c.relname AS tabela FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`;
    const comTenant = rows.map((r) => r.tabela);
    const exportadas = new Set<string>(EXPORTED_TABLES);
    const sobra = comTenant.filter((t) => !exportadas.has(t) && !(t in EXPORT_EXCLUDED_TABLES));
    expect(
      sobra,
      'tabela da clínica fora da exportação (G2): inclua em tenant-export.ts (EXPORTED_TABLES + pacote) ou justifique em EXPORT_EXCLUDED_TABLES',
    ).toEqual([]);
    expect(EXPORTED_TABLES.filter((t) => t in EXPORT_EXCLUDED_TABLES)).toEqual([]);
    for (const t of Object.keys(EXPORT_EXCLUDED_TABLES)) expect(EXPORT_EXCLUDED_TABLES[t]?.length).toBeGreaterThan(10);
  });

  it('toda coluna de tabela exportada vira campo do item (cifradas saem pelo nome sem _enc)', async () => {
    const faltando: string[] = [];
    for (const tabela of EXPORTED_TABLES) {
      const colunas = await sqlCat<{ coluna: string }[]>`
        SELECT a.attname AS coluna FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${tabela} AND a.attnum > 0 AND NOT a.attisdropped`;
      const chave = CHAVE_NO_PACOTE[tabela];
      const dado = (pkg.json.data as Record<string, unknown>)[chave];
      const item = (Array.isArray(dado) ? dado[0] : dado) as Record<string, unknown> | undefined;
      expect(item, `${tabela}: o pacote de teste precisa ter ao menos 1 item`).toBeDefined();
      for (const { coluna } of colunas) {
        if (coluna === 'tenant_id' || `${tabela}.${coluna}` in COLUNAS_FORA_DO_ITEM) continue;
        if (!(camel(coluna.replace(/_enc$/, '')) in (item ?? {}))) faltando.push(`${tabela}.${coluna}`);
      }
    }
    expect(faltando, 'coluna nova fora da exportação: inclua no pacote ou justifique em COLUNAS_FORA_DO_ITEM').toEqual([]);
  });
});

describe('G2 — conteúdo do pacote', () => {
  it('manifesto versionado com contagens iguais às do banco, só da clínica A', async () => {
    expect(pkg.json.manifest.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    const noBanco = await withTenant(api.db.db, clinicaA, async (tx) => {
      const n = async (t: typeof patients | typeof professionals | typeof appointmentTypes | typeof appointments) =>
        (await tx.select({ n: sql<number>`count(*)::int` }).from(t))[0]?.n ?? -1;
      return {
        tenants: 1,
        patients: await n(patients),
        professionals: await n(professionals),
        appointmentTypes: await n(appointmentTypes),
        appointments: await n(appointments),
      };
    });
    expect(pkg.json.manifest.counts).toEqual(noBanco);
    expect(noBanco).toEqual({ tenants: 1, patients: 2, professionals: 1, appointmentTypes: 1, appointments: 1 });
    const tudo = JSON.stringify(pkg);
    expect(tudo).not.toContain('Outra Clinica');
    expect(tudo).not.toContain('Prof B');
    expect(tudo).not.toContain(clinicaB);
  });

  it('campos cifrados saem decifrados para a própria clínica, no JSON e no CSV', () => {
    const p = pkg.json.data.patients.find((x) => x.displayName === 'Paciente Ficticia Export');
    expect(p).toMatchObject({ cpf: cpfFicticio(7), phone: '11900000007', birthDate: '2001-01-02', socialName: FORMULA, active: true });
    expect(JSON.stringify(pkg.json)).not.toMatch(/"v1:/);
    const [cabecalho] = pkg.patientsCsv.replace(UTF8_BOM, '').split('\r\n');
    expect(cabecalho).toBe(
      '"id","display_name","social_name","cpf","phone","birth_date","active","inactivated_at","created_at","updated_at"',
    );
    expect(pkg.patientsCsv).toContain(`"${cpfFicticio(7)}"`);
    expect(pkg.patientsCsv).not.toContain('v1:');
  });

  it('CSV neutraliza fórmula nas colunas novas; o JSON mantém o valor original', () => {
    expect(pkg.patientsCsv).toContain(`"'${FORMULA.replaceAll('"', '""')}"`);
    expect(pkg.patientsCsv).not.toContain(`,"${FORMULA.replaceAll('"', '""')}"`);
  });

  it('auditoria da exportação: 1 linha com contagens, sem conteúdo', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinicaA), eq(auditLog.scope, EXPORT_AUDIT_SCOPE))),
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.metadata).toMatchObject({ patients: 2, professionals: 1, appointmentTypes: 1, appointments: 1 });
    const serial = JSON.stringify(linhas[0]);
    for (const proibido of [cpfFicticio(7), '11900000007', '2001-01-02', 'Ficticia', 'HYPERLINK']) {
      expect(serial).not.toContain(proibido);
    }
  });

  it('sem a cifra de campo a exportação falha fechada (não entrega texto cifrado nem incompleto)', async () => {
    const ctx = { tenantId: clinicaA, userId: '00000000-0000-4000-8000-0000000000ee' as UserId, roles: ['admin'] };
    await expect(exportTenantData(api.db.db, ctx)).rejects.toBeInstanceOf(ExportCipherMissingError);
  });
});
