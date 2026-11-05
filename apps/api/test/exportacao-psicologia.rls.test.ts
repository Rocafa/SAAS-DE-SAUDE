/**
 * R12 do parecer do #123 (G2): a exportação total roda sem `mfaEm` e mesmo assim entrega a psicologia inteira,
 * decifrada e marcada no manifesto. A regra de MFA recente é da tela, não do pacote. Dados fictícios.
 */
import { randomUUID } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, tenants } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { MFA_RECENTE_MS } from '../src/modules/auth/mfa';
import { ExitWindowClosedError } from '../src/modules/exports/access-policy';
import { EXPORT_FAILED_AUDIT_SCOPE, ExportsService } from '../src/modules/exports/exports.module';
import type { TenantExportPackage } from '../src/modules/exports/tenant-export';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const TEMA_PSI = 'Tema ficticio de psicologia para exportacao';
const ADENDO_PSI = 'Adendo ficticio de psicologia';

let api: ApiDeTeste;
let clinica: TenantId;
let adminUserId: string;
let psiUserId: string;
let atPsi: string;
let pkg: TenantExportPackage;

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const admin = api.sessao(clinica, 'admin');
  await api.membro(clinica, admin, 'admin');
  adminUserId = admin.userId;
  const psiSessao = api.sessao(clinica, 'profissional');
  const psi = await api.membro(clinica, psiSessao, 'profissional', 'psicologo');
  psiUserId = psi.userId;
  // Sigilo máximo: só o autor vê. Mesmo assim o pacote da clínica leva tudo (G2).
  await api.http().put('/prontuario/configuracao').set(cab(admin)).send({ psicologia: 'restrito_ao_autor' }).expect(200);
  const prof = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Psi Ficticia Export', especialidade: 'Psicologia', usuarioId: psiUserId });
  expect(prof.status, JSON.stringify(prof.body)).toBe(201);
  const tipo = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 50 });
  const pac = await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticia Export Psi', telefone: '11900000051' });
  const pacienteId = (pac.body as { id: string }).id;
  const ag = randomUUID();
  const recepcao = randomUUID();
  await withTenant(
    api.db.db,
    clinica,
    (tx) =>
      tx.insert(appointments).values({
        createdBy: recepcao,
        id: ag,
        tenantId: clinica,
        patientId: pacienteId,
        professionalId: (prof.body as { id: string }).id,
        appointmentTypeId: (tipo.body as { id: string }).id,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 40 * 60_000),
        status: 'checked_in',
      }),
    recepcao,
  );
  const sessaoPsi = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: clinica, userId: psiUserId, perfis: ['profissional'], mfaEm: new Date() })}` };
  const at = await api.http().post('/atendimentos').set(cab(sessaoPsi)).send({ agendamentoId: ag });
  expect(at.status, JSON.stringify(at.body)).toBe(200);
  atPsi = (at.body as { id: string }).id;
  await api.http().put(`/atendimentos/${atPsi}/registro`).set(cab(sessaoPsi)).send({ versaoBase: 0, conteudo: { tema: TEMA_PSI, evolucao: 'Evolucao ficticia' } }).expect(200);
  await api.http().post(`/atendimentos/${atPsi}/finalizar`).set(cab(sessaoPsi)).send({}).expect(200);
  await api.http().post(`/atendimentos/${atPsi}/adendos`).set(cab(sessaoPsi)).send({ texto: ADENDO_PSI }).expect(201);

  // A exportação roda como o admin, sem `mfaEm` nenhum (e com MFA antigo daria no mesmo): o pacote não usa a regra da tela.
  pkg = await api.app.get(ExportsService).exportTenantData({ tenantId: clinica, userId: adminUserId as UserId, roles: ['admin'], mfaEm: null });
});

afterAll(async () => {
  await api?.fechar();
});

describe('R12 do #123: a exportação total leva a psicologia inteira e marcada', () => {
  it('o atendimento, a versão e o adendo de psicologia saem decifrados, sem nada oculto', () => {
    const { encounters, clinicalRecordVersions, clinicalAddenda } = pkg.json.data;
    expect(encounters.find((e) => e.id === atPsi)).toMatchObject({ compartment: 'psicologia', status: 'signed', authorUserId: psiUserId });
    expect(clinicalRecordVersions.filter((v) => v.encounterId === atPsi).map((v) => v.content)).toEqual([{ tema: TEMA_PSI, evolucao: 'Evolucao ficticia' }]);
    expect(clinicalAddenda.find((d) => d.encounterId === atPsi)).toMatchObject({ text: ADENDO_PSI });
  });

  it('o manifesto marca a seção de psicologia com contagens e ids iguais aos dados', () => {
    const { compartments, counts } = pkg.json.manifest;
    expect(compartments.psicologia).toEqual({ encounters: 1, clinicalRecordVersions: 1, clinicalAddenda: 1, encounterIds: [atPsi] });
    expect(compartments.geral).toEqual({ encounters: 0, clinicalRecordVersions: 0, clinicalAddenda: 0, encounterIds: [] });
    expect(compartments.psicologia.encounters + compartments.geral.encounters).toBe(counts.encounters);
    expect(compartments.psicologia.clinicalRecordVersions + compartments.geral.clinicalRecordVersions).toBe(counts.clinicalRecordVersions);
    expect(compartments.psicologia.clinicalAddenda + compartments.geral.clinicalAddenda).toBe(counts.clinicalAddenda);
  });

  it('o resultado não depende do MFA de quem pede: com MFA antigo o pacote é o mesmo', async () => {
    const antigo = new Date(Date.now() - MFA_RECENTE_MS - 60_000);
    const outro = await api.app.get(ExportsService).exportTenantData({ tenantId: clinica, userId: adminUserId as UserId, roles: ['admin'], mfaEm: antigo });
    expect(outro.json.manifest.compartments).toEqual(pkg.json.manifest.compartments);
    expect(outro.json.data.clinicalRecordVersions.map((v) => v.content)).toEqual(pkg.json.data.clinicalRecordVersions.map((v) => v.content));
  });

  it('nada do conteúdo de psicologia vai para a trilha da exportação', () => {
    for (const proibido of [TEMA_PSI, ADENDO_PSI]) expect(pkg.auditJsonl).not.toContain(proibido);
  });
});

describe('R2 do parecer do #126: exportação que cai deixa rastro', () => {
  it('clínica cancelada fora da janela: a exportação é recusada e grava 1 linha só com o motivo genérico', async () => {
    const outra = await api.novaClinica();
    const admin = api.sessao(outra, 'admin');
    await api.membro(outra, admin, 'admin');
    await withTenant(api.db.db, outra, (tx) => tx.update(tenants).set({ subscriptionStatus: 'cancelled', cancelledAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(tenants.id, outra)), admin.userId);
    const ctx = { tenantId: outra, userId: admin.userId as UserId, roles: ['admin'] };
    await expect(api.app.get(ExportsService).exportTenantData(ctx)).rejects.toBeInstanceOf(ExitWindowClosedError);
    const linhas = await withTenant(api.db.db, outra, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.tenantId, outra), eq(auditLog.scope, EXPORT_FAILED_AUDIT_SCOPE))));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ action: 'export', actorId: admin.userId, metadata: { reason: 'janela_de_saida_encerrada' } });
    expect(Object.keys(linhas[0]?.metadata as object)).toEqual(['reason']);
  });
});
