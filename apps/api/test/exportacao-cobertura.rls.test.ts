/**
 * G2 — a exportação cobre TODAS as tabelas da clínica. Lê o catálogo do Postgres (como a guarda de
 * schema) e reprova se uma tabela com tenant_id, ou uma coluna de tabela exportada, não estiver no
 * pacote nem na lista de exclusões com motivo. Depois exporta uma clínica fictícia completa pela
 * aplicação real (mesma cifra da API) e confere conteúdo, contagens, CSV e auditoria.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantId, UserId } from '@plataforma/shared';
import {
  auditLog,
  patients,
  professionals,
  appointmentTypes,
  appointments,
  appointmentReschedules,
  insurers,
  insuranceGuides,
  guideSessions,
  guideSessionSignatures,
  sessionPackages,
  packageSessions,
  clinicalSettings,
  encounters,
  clinicalRecordVersions,
  clinicalAddenda,
  privateNotes,
  legalHolds,
  noteCustodies,
  clinicMembers,
} from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { verifyExportedAuditTrail, type ExportedAuditEvent } from '../src/modules/audit/audit-chain';
import { insertAudit } from '../src/modules/audit/audit-log';
import { LocalPseudonymSigner, recordSupportAudit, supportActorPseudonym } from '../src/modules/audit/ator-suporte';
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
  insurers: 'insurers',
  insurance_guides: 'insuranceGuides',
  guide_sessions: 'guideSessions',
  guide_session_signatures: 'guideSessionSignatures',
  session_packages: 'sessionPackages',
  package_sessions: 'packageSessions',
  clinical_settings: 'clinicalSettings',
  encounters: 'encounters',
  clinical_record_versions: 'clinicalRecordVersions',
  clinical_addenda: 'clinicalAddenda',
  private_notes: 'privateNotes',
  appointment_reschedules: 'appointmentReschedules',
  legal_holds: 'legalHolds',
  note_custodies: 'noteCustodies',
  clinic_members: 'clinicMembers',
  audit_log: 'auditEvents',
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
/** Segredo do pseudônimo do suporte: gerado a cada execução, nunca fixo no código. */
const CHAVE_SUPORTE = randomBytes(32);
const ATENDENTE = 'atendente-ficticio-01';
/** Identificadores fictícios da guia (não são de operadora nenhuma). */
const GUIA_NUMERO = 'FIC-EXP-0001';
const GUIA_SENHA = 'SENHAEXP9';
const GUIA_CARTEIRINHA = 'CART-EXP-42';
/** Textos clínicos fictícios: no pacote decifrados; nunca na trilha. */
const TEXTO_CLINICO = 'Evolucao ficticia exportavel QZX7731';
const TEXTO_ADENDO = 'Adendo ficticio exportavel QZX7732';
const NOTA_EXPORTAVEL = 'Nota privada ficticia com decisao do autor QZX7733';
const NOTA_RETIDA = 'Nota privada ficticia sem decisao QZX7734';
const REFERENCIA_RETENCAO = 'Oficio ficticio de retencao QZX7735';
const MOTIVO_RETIRADA = 'Processo ficticio encerrado QZX7736';

beforeAll(async () => {
  sqlCat = postgres(url, { max: 1, onnotice: () => undefined });
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  const admin = api.sessao(clinicaA, 'admin', 'profissional');
  const prof = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticia', especialidade: 'Terapia ocupacional', usuarioId: admin.userId });
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
  // Uma remarcação (para o histórico da 0014 entrar no pacote).
  await api
    .http()
    .post(`/agendamentos/${(ag.body as { id: string }).id}/remarcar`)
    .set(cab(admin))
    .send({ data: '2030-05-07', hora: '09:00' })
    .expect(200);
  // Guias e pacotes (0011): convênio, guia com campos cifrados, consumo + confirmação, pacote + consumo.
  const pacienteId = (pac.body as { id: string }).id;
  const agId = (ag.body as { id: string }).id;
  await api.http().post(`/agendamentos/${agId}/check-in`).set(cab(admin)).expect(200);
  const conv = await api.http().post('/convenios').set(cab(admin)).send({ nome: 'Operadora Ficticia Export', exigeAssinatura: true });
  const guia = await api.http().post('/guias').set(cab(admin)).send({
    pacienteId,
    convenioId: (conv.body as { id: string }).id,
    numero: GUIA_NUMERO,
    senha: GUIA_SENHA,
    carteirinha: GUIA_CARTEIRINHA,
    sessoesAutorizadas: 5,
    validade: '2099-12-31',
  });
  expect(guia.status).toBe(201);
  const guiaId = (guia.body as { id: string }).id;
  const consumo = await api.http().post(`/guias/${guiaId}/consumos`).set(cab(admin)).send({ agendamentoId: agId });
  expect(consumo.status).toBe(201);
  const consumoId = (consumo.body as { consumoId: string }).consumoId;
  await api.http().post(`/guias/${guiaId}/consumos/${consumoId}/assinatura`).set(cab(admin)).send({ meio: 'tela' }).expect(201);
  const ag2 = await api.http().post('/agendamentos').set(cab(admin)).send({
    pacienteId,
    profissionalId: (prof.body as { id: string }).id,
    tipoId: (tipo.body as { id: string }).id,
    data: '2030-05-07',
    hora: '08:00',
  });
  const ag2Id = (ag2.body as { id: string }).id;
  await api.http().post(`/agendamentos/${ag2Id}/check-in`).set(cab(admin)).expect(200);
  const pacote = await api.http().post('/pacotes').set(cab(admin)).send({ pacienteId, nome: 'Pacote Ficticio Export', total: 4 });
  const pacoteId = (pacote.body as { id: string }).id;
  await api.http().post(`/pacotes/${pacoteId}/consumos`).set(cab(admin)).send({ agendamentoId: ag2Id }).expect(201);
  // Clínica B com dados próprios, que não podem aparecer no pacote de A.
  const adminB = api.sessao(clinicaB, 'admin');
  await api.http().post('/pacientes').set(cab(adminB)).send({ nome: 'Paciente Ficticio Outra Clinica', telefone: '11900000008' }).expect(201);
  await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof B', especialidade: 'Psico' }).expect(201);

  // Acesso de suporte (fictício) nas duas clínicas, pelo mesmo atendente: pseudônimos diferentes.
  for (const [tenantId, chamado] of [
    [clinicaA, 'SUP-1234'],
    [clinicaB, 'SUP-5678'],
  ] as const) {
    await withTenant(api.db.db, tenantId, (tx) =>
      recordSupportAudit(
        tx,
        new LocalPseudonymSigner(CHAVE_SUPORTE, 'test'),
        { tenantId, atendenteId: ATENDENTE, chamado, motivo: 'pedido_da_clinica' },
        { action: 'read', scope: 'patients', metadata: { count: 1 } },
      ),
    );
  }

  // Prontuário (0012): atendimento com 2 versões, finalizado, com adendo; sigilo configurado; duas
  // notas privadas, só UMA com a decisão do autor de exportar.
  const ag3 = randomUUID();
  const recepcao = randomUUID();
  await withTenant(api.db.db, clinicaA, (tx) =>
    tx.insert(appointments).values({
      createdBy: recepcao,
      id: ag3,
      tenantId: clinicaA,
      patientId: pacienteId,
      professionalId: (prof.body as { id: string }).id,
      appointmentTypeId: (tipo.body as { id: string }).id,
      startsAt: new Date(Date.now() - 10 * 60_000),
      endsAt: new Date(Date.now() + 30 * 60_000),
      status: 'checked_in',
    }),
  recepcao);
  const at = await api.http().post('/atendimentos').set(cab(admin)).send({ agendamentoId: ag3 });
  expect(at.status).toBe(200);
  const atId = (at.body as { id: string }).id;
  await api.http().put(`/atendimentos/${atId}/registro`).set(cab(admin)).send({ versaoBase: 0, conteudo: { queixa: 'Queixa v1' } }).expect(200);
  await api
    .http()
    .put(`/atendimentos/${atId}/registro`)
    .set(cab(admin))
    .send({ versaoBase: 1, conteudo: { queixa: TEXTO_CLINICO, conduta: 'Conduta ficticia', medidas: [{ tipo: 'eva', valor: 4 }] } })
    .expect(200);
  await api.http().post(`/atendimentos/${atId}/finalizar`).set(cab(admin)).send({}).expect(200);
  await api.http().post(`/atendimentos/${atId}/adendos`).set(cab(admin)).send({ texto: TEXTO_ADENDO }).expect(201);
  await api.http().put('/prontuario/configuracao').set(cab(admin)).send({ psicologia: 'restrito_ao_autor' }).expect(200);
  await api
    .http()
    .post(`/pacientes/${pacienteId}/notas-privadas`)
    .set(cab(admin))
    .send({ texto: NOTA_EXPORTAVEL, incluirNaExportacao: true })
    .expect(201);
  await api.http().post(`/pacientes/${pacienteId}/notas-privadas`).set(cab(admin)).send({ texto: NOTA_RETIDA }).expect(201);

  // Retenção legal (0017): marcada, pedida a retirada por um admin e aprovada por OUTRO.
  const admin2 = api.sessao(clinicaA, 'admin');
  await api.membro(clinicaA, admin, 'admin');
  await api.membro(clinicaA, admin2, 'admin');
  await api.http().put('/prontuario/pacientes/' + pacienteId + '/retencao-legal').set(cab(admin)).send({ referencia: REFERENCIA_RETENCAO }).expect(200);
  await api.http().post('/prontuario/pacientes/' + pacienteId + '/retencao-legal/retirada').set(cab(admin)).send({ motivo: MOTIVO_RETIRADA }).expect(200);
  await api.http().post('/prontuario/pacientes/' + pacienteId + '/retencao-legal/retirada/aprovacao').set(cab(admin2)).send({}).expect(200);
  // Custódia (0017): psicólogo autor e substituto; designada e aceita.
  const psiAutor = api.sessao(clinicaA, 'profissional');
  const psiSubst = api.sessao(clinicaA, 'profissional');
  await api.membro(clinicaA, psiAutor, 'psicologo');
  await api.membro(clinicaA, psiSubst, 'psicologo');
  const autorId = (await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Psi Autor Ficticio', especialidade: 'Psicologia', usuarioId: psiAutor.userId })).body as { id: string };
  const substId = (await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Psi Subst Ficticio', especialidade: 'Psicologia', usuarioId: psiSubst.userId })).body as { id: string };
  const cust = await api.http().post('/prontuario/custodias').set(cab(admin)).send({ autorProfissionalId: autorId.id, substitutoProfissionalId: substId.id });
  expect(cust.status).toBe(201);
  await api.http().post('/custodias/' + (cust.body as { id: string }).id + '/aceite').set(cab(psiSubst)).send({}).expect(200);

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
      const dado = tabela === 'audit_log' ? pkg.auditEvents : (pkg.json.data as Record<string, unknown>)[chave];
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
      const n = async (
        t:
          | typeof patients
          | typeof professionals
          | typeof appointmentTypes
          | typeof appointments
          | typeof appointmentReschedules
          | typeof insurers
          | typeof insuranceGuides
          | typeof guideSessions
          | typeof guideSessionSignatures
          | typeof sessionPackages
          | typeof packageSessions
          | typeof clinicalSettings
          | typeof encounters
          | typeof clinicalRecordVersions
          | typeof clinicalAddenda
          | typeof legalHolds
          | typeof noteCustodies
          | typeof clinicMembers,
      ) =>
        (await tx.select({ n: sql<number>`count(*)::int` }).from(t))[0]?.n ?? -1;
      return {
        tenants: 1,
        patients: await n(patients),
        professionals: await n(professionals),
        appointmentTypes: await n(appointmentTypes),
        appointments: await n(appointments),
        insurers: await n(insurers),
        insuranceGuides: await n(insuranceGuides),
        guideSessions: await n(guideSessions),
        guideSessionSignatures: await n(guideSessionSignatures),
        sessionPackages: await n(sessionPackages),
        packageSessions: await n(packageSessions),
        clinicalSettings: await n(clinicalSettings),
        encounters: await n(encounters),
        clinicalRecordVersions: await n(clinicalRecordVersions),
        clinicalAddenda: await n(clinicalAddenda),
        // Só as notas com decisão do autor saem; as outras aparecem SÓ como contagem.
        privateNotes: (await tx.select({ n: sql<number>`count(*)::int` }).from(privateNotes).where(eq(privateNotes.exportConsent, true)))[0]?.n ?? -1,
        privateNotesWithheld:
          (await tx.select({ n: sql<number>`count(*)::int` }).from(privateNotes).where(eq(privateNotes.exportConsent, false)))[0]?.n ?? -1,
        appointmentReschedules: await n(appointmentReschedules),
        legalHolds: await n(legalHolds),
        noteCustodies: await n(noteCustodies),
        clinicMembers: await n(clinicMembers),
        // A linha da própria exportação entra na trilha depois de montado o pacote.
        auditEvents: ((await tx.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]?.n ?? 0) - 1,
      };
    });
    expect(pkg.json.manifest.counts).toEqual(noBanco);
    expect(noBanco).toMatchObject({
      tenants: 1,
      patients: 2,
      professionals: 3,
      appointmentTypes: 1,
      appointments: 3,
      appointmentReschedules: 1,
      insurers: 1,
      insuranceGuides: 1,
      guideSessions: 1,
      guideSessionSignatures: 1,
      sessionPackages: 1,
      packageSessions: 1,
      clinicalSettings: 1,
      encounters: 1,
      clinicalRecordVersions: 2,
      clinicalAddenda: 1,
      privateNotes: 1,
      privateNotesWithheld: 1,
      legalHolds: 1,
      noteCustodies: 1,
    });
    // R16: perfis da clínica no pacote (fundador + 2 admins + 2 psicólogos), com o fundador no tenant.
    expect(noBanco.clinicMembers).toBeGreaterThanOrEqual(5);
    const fundador = api.fundador(clinicaA);
    expect(pkg.json.data.tenant.founderUserId).toBe(fundador);
    expect(pkg.json.data.clinicMembers).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: fundador, role: 'admin', grantedBy: fundador, revokedAt: null })]),
    );
    // Referência e motivo da retenção saem decifrados no pacote, nunca na trilha.
    expect(pkg.json.data.legalHolds[0]).toMatchObject({ reference: REFERENCIA_RETENCAO, releaseReason: MOTIVO_RETIRADA });
    expect(pkg.auditJsonl).not.toContain(REFERENCIA_RETENCAO);
    expect(pkg.auditJsonl).not.toContain(MOTIVO_RETIRADA);
    expect(noBanco.auditEvents).toBeGreaterThan(5);
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

  it('guia sai com número, senha e carteirinha decifrados; consumo, confirmação e pacote no pacote', () => {
    const { insuranceGuides: guias, guideSessions: consumos, guideSessionSignatures: assinaturas, sessionPackages: pacotes } = pkg.json.data;
    expect(guias[0]).toMatchObject({ number: GUIA_NUMERO, authorizationCode: GUIA_SENHA, cardNumber: GUIA_CARTEIRINHA, usedSessions: 1 });
    expect(consumos[0]).toMatchObject({ guideId: guias[0]?.id, reversedAt: null });
    expect(assinaturas[0]).toMatchObject({ guideSessionId: consumos[0]?.id, method: 'tela' });
    expect(assinaturas[0]?.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pacotes[0]).toMatchObject({ name: 'Pacote Ficticio Export', totalSessions: 4, usedSessions: 1 });
    // A trilha exportada não traz os identificadores da guia.
    for (const proibido of [GUIA_NUMERO, GUIA_SENHA, GUIA_CARTEIRINHA]) expect(pkg.auditJsonl).not.toContain(proibido);
  });

  it('prontuário: todas as versões e o adendo saem decifrados; finalização com hash; nada clínico na trilha', () => {
    const { encounters: ats, clinicalRecordVersions: versoes, clinicalAddenda: adendos, clinicalSettings: cfg } = pkg.json.data;
    expect(ats[0]).toMatchObject({ status: 'signed', currentVersion: 2, signedVersion: 2, template: 'to', compartment: 'geral', aiConsent: 'nao_informado' });
    expect(ats[0]?.signedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(versoes.map((v) => v.version)).toEqual([1, 2]);
    expect(versoes[0]?.content).toEqual({ queixa: 'Queixa v1' });
    expect(versoes[1]?.content).toMatchObject({ queixa: TEXTO_CLINICO, medidas: [{ tipo: 'eva', valor: 4 }] });
    expect(adendos[0]).toMatchObject({ text: TEXTO_ADENDO, encounterId: ats[0]?.id });
    expect(cfg).toEqual([expect.objectContaining({ psychCompartment: 'restrito_ao_autor' })]);
    for (const proibido of [TEXTO_CLINICO, TEXTO_ADENDO, NOTA_EXPORTAVEL, NOTA_RETIDA, 'Queixa v1']) expect(pkg.auditJsonl).not.toContain(proibido);
  });

  it('notas privadas: só a que o AUTOR marcou sai; a outra fica fora e é contada (cobertura não silenciosa)', () => {
    const notas = pkg.json.data.privateNotes;
    expect(notas).toHaveLength(1);
    expect(notas[0]).toMatchObject({ content: NOTA_EXPORTAVEL, exportConsent: true, discardedAt: null });
    expect(JSON.stringify(pkg.json)).not.toContain(NOTA_RETIDA);
    expect(pkg.json.manifest.counts).toMatchObject({ privateNotes: 1, privateNotesWithheld: 1 });
    expect(pkg.patientsCsv).not.toContain(NOTA_RETIDA);
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
    expect(linhas[0]?.metadata).toMatchObject({ patients: 2, professionals: 3, appointmentTypes: 1, appointments: 3, guides: 1, packages: 1 });
    const serial = JSON.stringify(linhas[0]);
    for (const proibido of [cpfFicticio(7), '11900000007', '2001-01-02', 'Ficticia', 'HYPERLINK', GUIA_NUMERO, GUIA_SENHA]) {
      expect(serial).not.toContain(proibido);
    }
  });

  it('sem a cifra de campo a exportação falha fechada (não entrega texto cifrado nem incompleto)', async () => {
    const ctx = { tenantId: clinicaA, userId: '00000000-0000-4000-8000-0000000000ee' as UserId, roles: ['admin'] };
    await expect(exportTenantData(api.db.db, ctx)).rejects.toBeInstanceOf(ExportCipherMissingError);
  });
});

/** SQLSTATE em qualquer ponto da cadeia de causas. */
async function sqlstates(p: Promise<unknown>): Promise<unknown[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  return codigos;
}

describe('G2 — trilha de auditoria no pacote (Decisão 1 do Guardião, PR #57)', () => {
  it('traz a cadeia inteira da clínica A, nada da B, e o verificador valida o pacote sem banco', () => {
    const { auditEvents, auditJsonl } = pkg;
    const { auditChain, counts } = pkg.json.manifest;
    expect(auditEvents.map((e) => e.seq)).toEqual(auditEvents.map((_, i) => i + 1));
    expect(auditChain).toEqual({ head: { seq: counts.auditEvents, hash: auditEvents.at(-1)?.hash }, legacy: 0 });
    const relatorio = verifyExportedAuditTrail(clinicaA, auditEvents, auditChain.head ? { anchor: auditChain.head } : {});
    expect(relatorio).toMatchObject({ ok: true, checked: counts.auditEvents, legacy: 0, problems: [] });
    // auditoria.jsonl: um evento por linha, igual ao objeto.
    const doArquivo = auditJsonl
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as ExportedAuditEvent);
    expect(doArquivo).toEqual(auditEvents);
    expect(JSON.stringify(auditEvents)).not.toContain(clinicaB);
    // Contrato do metadata: nenhum valor de paciente na trilha exportada.
    for (const proibido of [cpfFicticio(7), '11900000007', '2001-01-02', 'Ficticia', 'HYPERLINK']) {
      expect(auditJsonl).not.toContain(proibido);
    }
    expect(new Set(auditEvents.map((e) => e.actorKind))).toEqual(new Set(['usuario_clinica', 'suporte_plataforma']));
  });

  it('o atendente do suporte sai pseudonimizado por clínica, com chamado e motivo', async () => {
    const suporte = pkg.auditEvents.filter((e) => e.actorKind === 'suporte_plataforma');
    expect(suporte).toHaveLength(1);
    const pseudoA = supportActorPseudonym(CHAVE_SUPORTE, clinicaA, ATENDENTE);
    expect(suporte[0]).toMatchObject({
      actorId: pseudoA,
      metadata: { count: 1, ticket: 'SUP-1234', reason: 'pedido_da_clinica' },
    });
    expect(JSON.stringify(pkg)).not.toContain(ATENDENTE);
    // Na clínica B, o mesmo atendente tem outro pseudônimo: o id não liga as duas clínicas.
    const linhasB = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.actorKind, 'suporte_plataforma')),
    );
    expect(linhasB.map((l) => l.actorId)).toEqual([supportActorPseudonym(CHAVE_SUPORTE, clinicaB, ATENDENTE)]);
    expect(linhasB[0]?.actorId).not.toBe(pseudoA);
  });

  it('adulterar o pacote (campo, hash, linha apagada ou clínica trocada) é detectado pelo verificador', () => {
    const ev = pkg.auditEvents;
    const alvo = 3;
    const comCampo = ev.map((e) => (e.seq === alvo ? { ...e, actorId: '11111111-1111-4111-8111-111111111111' } : e));
    expect(verifyExportedAuditTrail(clinicaA, comCampo).problems).toEqual([{ seq: alvo, kind: 'field_mismatch' }]);
    const comHash = ev.map((e) => (e.seq === alvo ? { ...e, hash: 'f'.repeat(64) } : e));
    expect(verifyExportedAuditTrail(clinicaA, comHash).ok).toBe(false);
    const semUma = ev.filter((e) => e.seq !== alvo);
    expect(verifyExportedAuditTrail(clinicaA, semUma).problems.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['gap', 'broken_link']),
    );
    expect(verifyExportedAuditTrail(clinicaB, ev).ok).toBe(false);
  });

  it('banco recusa suporte sem chamado e "sistema" com id de usuário (CHECK da 0008)', async () => {
    const semChamado = withTenant(api.db.db, clinicaA, (tx) =>
      insertAudit(
        tx,
        { tenantId: clinicaA, actorId: supportActorPseudonym(CHAVE_SUPORTE, clinicaA, ATENDENTE), actorKind: 'suporte_plataforma' },
        { action: 'read', scope: 'patients', metadata: { count: 1 } },
      ),
    );
    expect(await sqlstates(semChamado)).toContain('23514');
    const sistemaFalso = withTenant(api.db.db, clinicaA, (tx) =>
      insertAudit(
        tx,
        { tenantId: clinicaA, actorId: '22222222-2222-4222-8222-222222222222', actorKind: 'sistema' },
        { action: 'read', scope: 'patients' },
      ),
    );
    expect(await sqlstates(sistemaFalso)).toContain('23514');
  });

  it('linha sem actor_kind (anterior à 0008) mantém o JSON canônico v1 da 0005: a cadeia antiga não quebra', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ atual: string; v1: string }>(sql`
        select audit_log_canonical(jsonb_populate_record(a, '{"actor_kind": null}'::jsonb)) as atual,
               jsonb_build_object(
                 'v', 1, 'tenant_id', a.tenant_id, 'seq', a.seq, 'prev_hash', a.prev_hash, 'id', a.id,
                 'actor_id', a.actor_id, 'action', a.action, 'scope', a.scope, 'metadata', a.metadata,
                 'created_at', to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               )::text as v1
        from audit_log a where a.tenant_id = ${clinicaA} and a.seq is not null`),
    );
    expect(linhas.length).toBeGreaterThan(0);
    for (const l of linhas) expect(l.atual).toBe(l.v1);
    // E toda linha nova tem tipo de ator.
    const semTipo = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(sql`seq is not null`, isNull(auditLog.actorKind))),
    );
    expect(semTipo[0]?.n).toBe(0);
  });
});
