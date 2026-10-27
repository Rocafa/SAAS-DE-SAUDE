/**
 * Integração front ↔ API (rodada 12.2): o adaptador HTTP do web (`apps/web/lib/api/http.ts`) contra
 * a API REAL escutando numa porta local, com Postgres real e sessão fictícia (NODE_ENV=test).
 * Fluxo: login fictício (sessão da recepção) → listar/criar/buscar paciente → agendar → check-in.
 * Confere também: nenhum cabeçalho de tenant sai do adaptador, outra clínica não enxerga nada,
 * a busca vira auditoria sem o termo e o logout derruba a sessão (401 + limpeza do retrato).
 * Dados 100% fictícios, gerados a cada execução.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

// Tipos mínimos do que o teste usa do adaptador (o arquivo é do app web; importado em tempo de execução).
interface PacienteWeb {
  id: string;
  nome: string;
  telefone: string;
  cpf: string;
  ativo: boolean;
}
interface AgendamentoWeb {
  id: string;
  pacienteId: string;
  data: string;
  hora: string;
  status: string;
}
interface ApiWeb {
  usuarioAtual(): Promise<{ id: string; papel: string; clinicaId?: string }>;
  listarPacientes(): Promise<PacienteWeb[]>;
  buscarPacientes(termo: string): Promise<PacienteWeb[]>;
  obterPaciente(id: string): Promise<PacienteWeb | null>;
  criarPaciente(d: { nome: string; telefone: string; cpf?: string }): Promise<PacienteWeb>;
  listarProfissionais(): Promise<{ id: string; limiteSimultaneo?: number }[]>;
  listarTiposAtendimento(): Promise<{ id: string; minutos: number }[]>;
  listarAgendamentos(f?: { de?: string; ate?: string; pacienteId?: string }): Promise<AgendamentoWeb[]>;
  criarAgendamento(d: { pacienteId: string; data: string; hora: string; profissionalId?: string; tipoId?: string }): Promise<AgendamentoWeb>;
  alterarStatus(id: string, status: string): Promise<string>;
}
interface ModuloAdaptador {
  criarApiHttp(o: {
    baseUrl: string;
    fetch?: typeof fetch;
    obterToken?: () => string | null;
    aoPerderSessao?: () => void;
  }): ApiWeb;
  MENSAGENS: Record<string, string>;
}

const CAMINHO_ADAPTADOR = resolve(__dirname, '../../web/lib/api/http.ts');

let api: ApiDeTeste;
let mod: ModuloAdaptador;
let base: string;
let clinicaA: TenantId;
let clinicaB: TenantId;
const cabecalhosVistos: string[] = [];

/** fetch que registra os nomes dos cabeçalhos enviados (para provar que não sai tenant). */
const fetchEspiao: typeof fetch = (entrada, init) => {
  for (const k of Object.keys(init?.headers ?? {})) cabecalhosVistos.push(k.toLowerCase());
  return fetch(entrada, init);
};

function tokenDe(s: { Authorization: string }): string {
  return s.Authorization.replace(/^Bearer /, '');
}

function hojeIso(): string {
  // A API grava data/hora no fuso de Brasília (UTC−03:00 fixo).
  return new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  api = await subirApi();
  await api.app.listen(0, '127.0.0.1');
  const { port } = (api.app.getHttpServer() as Server).address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  mod = (await import(pathToFileURL(CAMINHO_ADAPTADOR).href)) as ModuloAdaptador;

  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  const admin = api.sessao(clinicaA, 'admin');
  const prof = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Fisio Ficticia', especialidade: 'Fisioterapia', capacidade: 1 });
  expect(prof.status).toBe(201);
  const tipo = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao Ficticia', minutos: 50 });
  expect(tipo.status).toBe(201);
});

afterAll(async () => {
  await api?.fechar();
});

describe('adaptador HTTP do web contra a API real', () => {
  it('login fictício → pacientes → agendar → check-in, sem cabeçalho de tenant', async () => {
    const sessao = api.sessao(clinicaA, 'recepcao');
    const web = mod.criarApiHttp({ baseUrl: base, fetch: fetchEspiao, obterToken: () => tokenDe(sessao) });

    const eu = await web.usuarioAtual();
    expect(eu).toMatchObject({ id: sessao.userId, papel: 'recepcao', clinicaId: clinicaA });

    const novo = await web.criarPaciente({ nome: 'Paciente Ficticia Integracao', telefone: '(11) 90000-0101' });
    expect(novo.id).toMatch(/^[0-9a-f-]{36}$/);

    const lista = await web.listarPacientes();
    const naLista = lista.find((p) => p.id === novo.id);
    // A lista é a projeção mínima: sem telefone nem CPF.
    expect(naLista).toMatchObject({ nome: 'Paciente Ficticia Integracao', telefone: '', cpf: '', ativo: true });

    expect((await web.obterPaciente(novo.id))?.telefone).toBe('11900000101');

    const [profissional] = await web.listarProfissionais();
    const [tipo] = await web.listarTiposAtendimento();
    expect(profissional?.limiteSimultaneo).toBe(1);
    const dia = hojeIso();
    const ag = await web.criarAgendamento({ pacienteId: novo.id, data: dia, hora: '23:00', profissionalId: profissional!.id, tipoId: tipo!.id });
    expect(ag).toMatchObject({ pacienteId: novo.id, data: dia, hora: '23:00', status: 'agendado' });

    // Lotado (capacidade 1) vira a mensagem da tela.
    await expect(
      web.criarAgendamento({ pacienteId: novo.id, data: dia, hora: '23:00', profissionalId: profissional!.id, tipoId: tipo!.id }),
    ).rejects.toThrow(mod.MENSAGENS.lotado);

    expect(await web.alterarStatus(ag.id, 'chegou')).toBe('agendado');
    const agenda = await web.listarAgendamentos(); // janela padrão (−30/+90), em várias chamadas de ≤ 31 dias
    expect(agenda.find((a) => a.id === ag.id)?.status).toBe('chegou');

    expect(cabecalhosVistos.length).toBeGreaterThan(0);
    expect([...new Set(cabecalhosVistos)].sort()).toEqual(['accept', 'authorization', 'content-type']);
  });

  it('outra clínica não enxerga o paciente nem a agenda (clínica vem só da sessão)', async () => {
    // Uma sessão por clínica (o adaptador confere que a sessão não mudou no meio da paginação).
    const sa = api.sessao(clinicaA, 'recepcao');
    const sb = api.sessao(clinicaB, 'admin');
    const a = mod.criarApiHttp({ baseUrl: base, obterToken: () => tokenDe(sa) });
    const b = mod.criarApiHttp({ baseUrl: base, obterToken: () => tokenDe(sb) });
    const p = await a.criarPaciente({ nome: 'Paciente Ficticio Isolado', telefone: '(11) 90000-0102' });
    expect(await b.obterPaciente(p.id)).toBeNull();
    expect((await b.listarPacientes()).some((x) => x.id === p.id)).toBe(false);
    expect(await b.listarAgendamentos({ pacienteId: p.id })).toEqual([]);
  });

  it('busca (POST, termo no corpo) acha o paciente e entra na auditoria sem o termo', async () => {
    const s = api.sessao(clinicaA, 'recepcao');
    const web = mod.criarApiHttp({ baseUrl: base, obterToken: () => tokenDe(s) });
    const p = await web.criarPaciente({ nome: 'Paciente Ficticia Integracao Busca', telefone: '(11) 90000-0104' });
    expect((await web.buscarPacientes('integracao busca')).map((x) => x.id)).toContain(p.id);
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinicaA), eq(auditLog.actorId, s.userId))),
    );
    expect(linhas.some((l) => l.scope === 'patients' && (l.metadata as { search?: boolean }).search === true)).toBe(true);
    expect(JSON.stringify(linhas)).not.toContain('integracao');
  });

  it('logout: sessão encerrada no servidor → 401 com mensagem da tela e limpeza do retrato', async () => {
    const s = api.sessao(clinicaA, 'recepcao');
    let limpou = 0;
    const web = mod.criarApiHttp({ baseUrl: base, obterToken: () => tokenDe(s), aoPerderSessao: () => limpou++ });
    await web.usuarioAtual();
    api.sessoes.encerrarSessao(tokenDe(s));
    await expect(web.listarPacientes()).rejects.toThrow(mod.MENSAGENS.sessao);
    expect(limpou).toBe(1);
  });

  it('financeiro não marca consulta: 403 vira a mensagem de permissão', async () => {
    const fin = mod.criarApiHttp({ baseUrl: base, obterToken: () => tokenDe(api.sessao(clinicaA, 'financeiro')) });
    await expect(fin.criarPaciente({ nome: 'Paciente Ficticio Negado', telefone: '(11) 90000-0103' })).rejects.toThrow(mod.MENSAGENS.proibido);
  });
});
