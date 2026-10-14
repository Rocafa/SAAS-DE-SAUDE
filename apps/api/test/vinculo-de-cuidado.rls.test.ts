/**
 * Vínculo de cuidado (R2 do parecer PR #57) contra Postgres REAL: derivado no servidor a partir da
 * agenda da clínica da sessão. Com vínculo, sem vínculo, outra clínica, vínculo expirado, cancelado
 * e agenda futura. Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user.
 * Dados 100% fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProibidoError } from '../src/common/erros-dominio';
import { eq } from 'drizzle-orm';
import { appointments, professionals, type AppointmentStatusDb } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import {
  exigirConteudoClinico,
  VINCULO_AGENDA_HORAS,
  VINCULO_ATENDIMENTO_DIAS,
  VinculoDeCuidadoService,
} from '../src/modules/auth/vinculo-de-cuidado';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const DIA = 86_400_000;
const HORA = 3_600_000;
const agora = new Date();

let api: ApiDeTeste;
let servico: VinculoDeCuidadoService;
let clinicaA: TenantId;
let clinicaB: TenantId;
let profA: { Authorization: string; userId: string };
let outroProfA: { Authorization: string; userId: string };
let profB: { Authorization: string; userId: string };
let profissionalA: string;
let outroProfissionalA: string;
let profissionalB: string;
let tipoA: string;
let tipoB: string;

const ctx = (tenantId: TenantId, s: { userId: string }, ...roles: string[]): RequestContext => ({
  tenantId,
  userId: s.userId as UserId,
  roles: roles.length ? roles : ['profissional'],
});

async function novoPaciente(adminTenant: { Authorization: string }): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(adminTenant)).send({ nome: 'Paciente Ficticio Vinculo', telefone: '11900000009' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function profissional(admin: { Authorization: string }, usuarioId: string): Promise<string> {
  const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio', especialidade: 'Fisioterapia', usuarioId });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function tipo(admin: { Authorization: string }): Promise<string> {
  const res = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Individual', minutos: 50 });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** Agendamento direto no banco (datas no passado não passam pela rota de agenda). */
async function agendamento(
  tenantId: TenantId,
  dados: { paciente: string; profissional: string; tipo: string; inicio: Date; status: AppointmentStatusDb },
): Promise<void> {
  await withTenant(api.db.db, tenantId, async (tx) => {
    await tx.insert(appointments).values({
      id: randomUUID(),
      tenantId,
      patientId: dados.paciente,
      professionalId: dados.profissional,
      appointmentTypeId: dados.tipo,
      startsAt: dados.inicio,
      endsAt: new Date(dados.inicio.getTime() + 50 * 60_000),
      status: dados.status,
      cancelledAt: dados.status === 'cancelled' ? dados.inicio : null,
    });
  });
}

let adminA: { Authorization: string; userId: string };
let adminB: { Authorization: string; userId: string };

beforeAll(async () => {
  api = await subirApi();
  servico = api.app.get(VinculoDeCuidadoService);
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  adminB = api.sessao(clinicaB, 'admin');
  profA = api.sessao(clinicaA, 'profissional');
  outroProfA = api.sessao(clinicaA, 'profissional');
  profB = api.sessao(clinicaB, 'profissional');
  profissionalA = await profissional(adminA, profA.userId);
  outroProfissionalA = await profissional(adminA, outroProfA.userId);
  profissionalB = await profissional(adminB, profB.userId);
  tipoA = await tipo(adminA);
  tipoB = await tipo(adminB);
});

afterAll(async () => {
  await api?.fechar();
});

describe('vínculo de cuidado derivado no servidor (R2)', () => {
  it('com vínculo: atendimento recente com o profissional da sessão', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - 30 * DIA), status: 'completed' });
    const v = await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora);
    expect(v).toMatchObject({ temVinculo: true, base: 'atendimento' });
  });

  it('com vínculo: consulta do dia ainda não atendida (agendada/confirmada/check-in)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() + 2 * HORA), status: 'confirmed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: true, base: 'agenda_do_dia' });
  });

  it('sem vínculo: profissional da MESMA clínica sem agendamento com o paciente (403 no porteiro)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, outroProfA), p, agora)).toMatchObject({ temVinculo: false, base: null });
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, outroProfA), p, agora)),
    ).rejects.toBeInstanceOf(ProibidoError);
    // O dono do vínculo passa no porteiro.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, profA), p, agora)),
    ).resolves.toMatchObject({ base: 'atendimento' });
  });

  it('perfil não clínico com o mesmo usuário do profissional: 403 (perfil E vínculo)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    for (const perfil of ['admin', 'recepcao', 'financeiro']) {
      await expect(
        withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, profA, perfil), p, agora)),
        perfil,
      ).rejects.toBeInstanceOf(ProibidoError);
    }
  });

  it('outra clínica: profissional de B nunca tem vínculo com paciente de A, nem com o mesmo usuário', async () => {
    const pA = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: pA, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    // Sessão da clínica B com o id do paciente de A: RLS + filtro por tenant -> sem vínculo.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profB), pA, agora)).toMatchObject({ temVinculo: false });
    // Mesmo userId do profissional de A, mas sessão em B: o vínculo é da clínica A, não viaja.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profA), pA, agora)).toMatchObject({ temVinculo: false });
    // E o profissional de B, com agenda própria em B, só tem vínculo com o paciente de B.
    const pB = await novoPaciente(adminB);
    await agendamento(clinicaB, { paciente: pB, profissional: profissionalB, tipo: tipoB, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profB), pB, agora)).toMatchObject({ temVinculo: true });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profB), pB, agora)).toMatchObject({ temVinculo: false });
  });

  it('vínculo expirado: último atendimento fora da janela de continuidade', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, {
      paciente: p,
      profissional: profissionalA,
      tipo: tipoA,
      inicio: new Date(agora.getTime() - (VINCULO_ATENDIMENTO_DIAS + 1) * DIA),
      status: 'completed',
    });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
    // Dois dias atrás, o mesmo atendimento ainda estava dentro da janela.
    const quase = new Date(agora.getTime() - 2 * DIA);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, quase)).toMatchObject({ temVinculo: true });
  });

  it('cancelado, falta, agenda futura fora da janela e agenda velha não atendida não dão vínculo', async () => {
    const p = await novoPaciente(adminA);
    const casos: { inicio: Date; status: AppointmentStatusDb }[] = [
      { inicio: new Date(agora.getTime() - DIA), status: 'cancelled' },
      { inicio: new Date(agora.getTime() - DIA), status: 'no_show' },
      { inicio: new Date(agora.getTime() + (VINCULO_AGENDA_HORAS + 2) * HORA), status: 'scheduled' },
      { inicio: new Date(agora.getTime() - (VINCULO_AGENDA_HORAS + 2) * HORA), status: 'confirmed' },
    ];
    for (const c of casos) await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, ...c });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
  });

  it('profissional inativado perde o vínculo', async () => {
    const usuario = api.sessao(clinicaA, 'profissional');
    const prof = await profissional(adminA, usuario.userId);
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: prof, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, usuario), p, agora)).toMatchObject({ temVinculo: true });
    // Sem rota de inativação ainda: direto no banco, na transação da clínica.
    await withTenant(api.db.db, clinicaA, (tx) => tx.update(professionals).set({ active: false }).where(eq(professionals.id, prof)));
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, usuario), p, agora)).toMatchObject({ temVinculo: false });
  });

  it('a requisição não concede vínculo: nenhuma rota aceita campo de vínculo', async () => {
    // Não há rota clínica ainda; a garantia aqui é de tipo (VinculoDeCuidado é marcado) e de que
    // o vínculo do outro profissional nunca se transfere, testado acima. Este caso fixa o código.
    const p = await novoPaciente(adminA);
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, outroProfA), p, agora)),
    ).rejects.toMatchObject({ response: { codigo: 'sem_vinculo_de_cuidado' } });
    // Mesmo com agendamento do OUTRO profissional (outroProfissionalA) com o paciente, o vínculo é dele.
    await agendamento(clinicaA, { paciente: p, profissional: outroProfissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, outroProfA), p, agora)).toMatchObject({ temVinculo: true });
  });
});
