/**
 * Adaptador HTTP (pacientes e agenda) com fetch simulado: rotas e corpos, mapeamentos, janelas da
 * agenda, erros (401/403/409/429/503/timeout/rede) com mensagem fixa em pt-BR, e a regra 1 da D4:
 * NENHUM cabeçalho, query ou corpo leva tenant/clínica. Dados 100% fictícios.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarApiHttp, ErroApi, JANELA_PADRAO, MENSAGENS, mensagemDeErro } from './http';
import { criarApi, lerConfigApi, paraIndice } from './selecionar';

const BASE = 'http://127.0.0.1:3333';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Chamada {
  url: URL;
  metodo: string;
  headers: Record<string, string>;
  corpo: unknown;
  init: RequestInit;
}

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(corpo === undefined ? null : JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function simular(responder: (c: Chamada) => Response | Promise<Response>) {
  const chamadas: Chamada[] = [];
  const fetchFalso = vi.fn(async (entrada: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: Chamada = {
      url: new URL(String(entrada)),
      metodo: init.method ?? 'GET',
      headers,
      corpo: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      init,
    };
    chamadas.push(c);
    return responder(c);
  });
  return { chamadas, fetch: fetchFalso as unknown as typeof fetch };
}

const AGORA = new Date(2026, 9, 13, 10, 0);

describe('adaptador HTTP: sessão e clínica', () => {
  it('nunca envia tenant/clínica: só Accept, Content-Type e Authorization (dev); cookies incluídos', async () => {
    const { chamadas, fetch } = simular((c) => {
      if (c.url.pathname === '/sessao') return respostaJson(200, { usuarioId: U(1), clinicaId: U(9), perfis: ['recepcao'] });
      if (c.url.pathname.startsWith('/pacientes')) return respostaJson(200, { itens: [], temMais: false });
      if (c.url.pathname === '/agendamentos' && c.metodo === 'GET') return respostaJson(200, { itens: [], truncado: false });
      if (c.url.pathname === '/agendamentos') return respostaJson(201, { id: U(5), pacienteId: U(2), profissionalId: U(3), tipoId: U(4), data: '2026-10-14', hora: '09:00', minutos: 50, status: 'agendado', encaixe: false });
      return respostaJson(200, { statusAnterior: 'agendado' });
    });
    const api = criarApiHttp({ baseUrl: BASE, fetch, obterToken: () => 'token-ficticio', agora: () => AGORA });
    await api.usuarioAtual();
    await api.listarPacientes();
    await api.buscarPacientes!('mar');
    await api.listarAgendamentos({ de: '2026-10-13', ate: '2026-10-13' });
    await api.criarAgendamento({ pacienteId: U(2), profissionalId: U(3), tipoId: U(4), data: '2026-10-14', hora: '09:00' });
    await api.alterarStatus(U(5), 'chegou');
    await api.alterarStatus(U(5), 'confirmado');
    expect(chamadas.length).toBeGreaterThanOrEqual(7);
    for (const c of chamadas) {
      expect(Object.keys(c.headers).every((k) => ['accept', 'content-type', 'authorization'].includes(k)), JSON.stringify(c.headers)).toBe(true);
      expect(c.headers.authorization).toBe('Bearer token-ficticio');
      expect(c.init.credentials).toBe('include');
      expect(c.init.cache).toBe('no-store');
      const tudo = `${c.url.search} ${JSON.stringify(c.corpo ?? {})}`.toLowerCase();
      expect(tudo).not.toMatch(/tenant|clinica/);
      expect(c.url.origin).toBe(BASE);
    }
  });

  it('sem obterToken não envia Authorization (navegador: sessão em cookie HttpOnly, D4)', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(200, { usuarioId: U(1), clinicaId: U(9), perfis: ['admin'] }));
    const u = await criarApiHttp({ baseUrl: BASE, fetch }).usuarioAtual();
    expect(chamadas[0]!.headers.authorization).toBeUndefined();
    expect(u).toMatchObject({ id: U(1), clinicaId: U(9), papel: 'admin' });
  });

  it('recusa origem com caminho, curinga ou esquema estranho', () => {
    for (const b of ['https://api.test/v1', '*', 'javascript:alert(1)', 'https://*.test']) {
      expect(() => criarApiHttp({ baseUrl: b })).toThrow();
    }
  });
});

describe('adaptador HTTP: pacientes', () => {
  it('lista pagina até temMais=false e devolve só a projeção da lista', async () => {
    const { chamadas, fetch } = simular((c) => {
      const pagina = Number(c.url.searchParams.get('pagina'));
      return respostaJson(200, {
        itens: [{ id: U(pagina), nome: `Paciente Ficticio ${pagina}`, nomeSocial: pagina === 2 ? 'Social' : null, ativo: true }],
        temMais: pagina < 3,
      });
    });
    const lista = await criarApiHttp({ baseUrl: BASE, fetch }).listarPacientes();
    expect(lista).toHaveLength(3);
    expect(chamadas.map((c) => c.url.searchParams.get('limite'))).toEqual(['100', '100', '100']);
    expect(lista[1]).toMatchObject({ nomeSocial: 'Social', cpf: '', telefone: '', nascimento: '' });
  });

  it('busca vai ao servidor (auditada) e termo curto não chama', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(200, { itens: [], temMais: false }));
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    expect(await api.buscarPacientes!('a')).toEqual([]);
    expect(chamadas).toHaveLength(0);
    await api.buscarPacientes!('  ana   paula ');
    expect(chamadas[0]!.metodo).toBe('POST');
    expect(chamadas[0]!.url.pathname).toBe('/pacientes/busca');
    expect(chamadas[0]!.url.search).toBe('');
    expect(chamadas[0]!.corpo).toMatchObject({ busca: 'ana paula', pagina: 1, limite: 100 });
  });

  it('nenhuma URL leva nome, CPF ou telefone (só ids opacos, datas e paginação)', async () => {
    const { chamadas, fetch } = simular((c) => {
      if (c.url.pathname.startsWith('/pacientes') && c.metodo === 'POST' && c.url.pathname !== '/pacientes/busca')
        return respostaJson(201, { id: U(1), nome: 'Maria Ficticia', nomeSocial: null, cpf: '00000000191', telefone: '11900000001', nascimento: null, ativo: true });
      if (c.url.pathname.startsWith('/pacientes')) return respostaJson(200, { itens: [], temMais: false });
      return respostaJson(200, { itens: [] });
    });
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    await api.buscarPacientes!('Maria Ficticia');
    await api.buscarPacientes!('000.000.001-91');
    await api.buscarPacientes!('(11) 90000-0001');
    await api.criarPaciente({ nome: 'Maria Ficticia', telefone: '(11) 90000-0001', cpf: '000.000.001-91' });
    await api.listarPacientes();
    await api.listarAgendamentos({ de: '2026-10-13', ate: '2026-10-13', pacienteId: U(1) });
    for (const c of chamadas) {
      const url = decodeURIComponent(c.url.href).toLowerCase();
      expect(url).not.toMatch(/maria|ficticia|000\.000|00000000191|90000|busca=/);
    }
  });

  it('obterPaciente: 404 e id não-UUID viram null', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(404, { statusCode: 404, message: 'Não encontrado' }));
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    expect(await api.obterPaciente('p01')).toBeNull();
    expect(chamadas).toHaveLength(0);
    expect(await api.obterPaciente(U(1))).toBeNull();
  });

  it('criarPaciente manda só os campos da API; responsável ainda não suportado', async () => {
    const { chamadas, fetch } = simular(() =>
      respostaJson(201, { id: U(1), nome: 'Ficticia', nomeSocial: null, cpf: null, telefone: '11900000001', nascimento: null, ativo: true }),
    );
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    await api.criarPaciente({ nome: ' Ficticia ', telefone: '(11) 90000-0001', cpf: '' });
    expect(chamadas[0]!.corpo).toEqual({ nome: 'Ficticia', telefone: '(11) 90000-0001' });
    await expect(
      api.criarPaciente({ nome: 'Menor', telefone: '(11) 90000-0002', responsavel: { nome: 'R', parentesco: 'Mãe', telefone: '(11) 90000-0003' } }),
    ).rejects.toThrow(MENSAGENS.semResponsavel);
  });
});

describe('adaptador HTTP: agenda', () => {
  it('sem período usa a janela padrão (−30/+90) quebrada em janelas de até 31 dias', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(200, { itens: [], truncado: false }));
    await criarApiHttp({ baseUrl: BASE, fetch, agora: () => AGORA }).listarAgendamentos();
    const janelas: [string, string][] = chamadas.map((c) => [c.url.searchParams.get('de') ?? '', c.url.searchParams.get('ate') ?? '']);
    expect(janelas[0]![0]).toBe('2026-09-13');
    expect(janelas.at(-1)![1]).toBe('2027-01-11');
    for (const [de, ate] of janelas) {
      const dias = (Date.parse(ate) - Date.parse(de)) / 86_400_000;
      expect(dias).toBeGreaterThanOrEqual(0);
      expect(dias).toBeLessThan(31);
    }
    for (let i = 1; i < janelas.length; i++) {
      expect((Date.parse(janelas[i]![0]) - Date.parse(janelas[i - 1]![1])) / 86_400_000).toBe(1);
    }
    expect(JANELA_PADRAO).toEqual({ antes: 30, depois: 90 });
  });

  it('período maior que 6 meses é recusado sem chamar a API', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(200, { itens: [] }));
    await expect(criarApiHttp({ baseUrl: BASE, fetch }).listarAgendamentos({ de: '2026-01-01', ate: '2026-12-31' })).rejects.toThrow(
      MENSAGENS.periodoLongo,
    );
    expect(chamadas).toHaveLength(0);
  });

  it('ordena, remove campos extras e mapeia status/remarcar/cancelar', async () => {
    const { chamadas, fetch } = simular((c) => {
      if (c.metodo === 'GET')
        return respostaJson(200, {
          itens: [
            { id: U(2), pacienteId: U(7), profissionalId: U(8), tipoId: U(9), data: '2026-10-13', hora: '11:00', minutos: 50, status: 'agendado', encaixe: false, inicio: 'x', fim: 'y' },
            { id: U(1), pacienteId: U(7), profissionalId: U(8), tipoId: U(9), data: '2026-10-13', hora: '09:00', minutos: 50, status: 'chegou', encaixe: true, inicio: 'x', fim: 'y' },
          ],
        });
      if (c.url.pathname.endsWith('/remarcar')) return respostaJson(200, { data: '2026-10-13', hora: '09:00' });
      return respostaJson(200, { statusAnterior: 'confirmado' });
    });
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    const ags = await api.listarAgendamentos({ de: '2026-10-13', ate: '2026-10-13' });
    expect(ags.map((a) => a.hora)).toEqual(['09:00', '11:00']);
    expect(ags[0]).not.toHaveProperty('inicio');
    expect(await api.remarcarAgendamento(U(1), '2026-10-15', '10:00')).toEqual({ data: '2026-10-13', hora: '09:00' });
    expect(await api.alterarStatus(U(1), 'chegou')).toBe('confirmado');
    await api.removerAgendamento(U(1));
    expect(chamadas.slice(1).map((c) => `${c.metodo} ${c.url.pathname} ${JSON.stringify(c.corpo)}`)).toEqual([
      `POST /agendamentos/${U(1)}/remarcar {"data":"2026-10-15","hora":"10:00"}`,
      `POST /agendamentos/${U(1)}/check-in {}`,
      `POST /agendamentos/${U(1)}/cancelar {}`,
    ]);
  });

  it('criarAgendamento exige profissional e tipo reais (sem chamar a API)', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(201, {}));
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    await expect(api.criarAgendamento({ pacienteId: U(1), data: '2026-10-14', hora: '09:00', profissionalId: 'pr1', tipoId: U(2) })).rejects.toThrow(
      MENSAGENS.faltaProfissional,
    );
    await expect(api.criarAgendamento({ pacienteId: U(1), data: '2026-10-14', hora: '09:00', profissionalId: U(3) })).rejects.toThrow(MENSAGENS.faltaTipo);
    expect(chamadas).toHaveLength(0);
  });

  it('série é tudo ou nada: falhou no meio, cancela as já marcadas', async () => {
    let n = 0;
    const { chamadas, fetch } = simular((c) => {
      if (c.url.pathname === '/agendamentos') {
        n++;
        if (n === 3) return respostaJson(409, { statusCode: 409, message: 'Conflito', codigo: 'horario_lotado' });
        const corpo = c.corpo as { data: string };
        return respostaJson(201, { id: U(n), pacienteId: U(7), profissionalId: U(8), tipoId: U(9), data: corpo.data, hora: '09:00', minutos: 50, status: 'agendado', encaixe: false });
      }
      return respostaJson(200, { statusAnterior: 'agendado' });
    });
    const api = criarApiHttp({ baseUrl: BASE, fetch });
    await expect(
      api.criarSerie({ pacienteId: U(7), profissionalId: U(8), tipoId: U(9), data: '2026-10-14', hora: '09:00' }, { intervaloDias: 7, vezes: 4 }),
    ).rejects.toThrow(MENSAGENS.lotado);
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/cancelar')).map((c) => c.url.pathname)).toEqual([
      `/agendamentos/${U(1)}/cancelar`,
      `/agendamentos/${U(2)}/cancelar`,
    ]);
    expect(chamadas.filter((c) => c.metodo === 'POST' && c.url.pathname === '/agendamentos').map((c) => (c.corpo as { data: string }).data)).toEqual([
      '2026-10-14',
      '2026-10-21',
      '2026-10-28',
    ]);
  });
});

describe('adaptador HTTP: erros', () => {
  it.each([
    [401, {}, MENSAGENS.sessao],
    [403, { codigo: 'x' }, MENSAGENS.proibido],
    [403, { codigo: 'assinatura_bloqueia_escrita' }, MENSAGENS.assinatura],
    [404, {}, MENSAGENS.naoEncontrado],
    [409, { codigo: 'horario_lotado' }, MENSAGENS.lotado],
    [409, { codigo: 'transicao_invalida' }, MENSAGENS.transicao],
    [409, { codigo: 'outro' }, MENSAGENS.conflito],
    [429, {}, MENSAGENS.muitas],
    [503, {}, MENSAGENS.indisponivel],
    [500, { message: 'stack interna' }, MENSAGENS.servidor],
  ])('HTTP %i vira mensagem fixa', async (status, corpo, texto) => {
    const { fetch } = simular(() => respostaJson(status, corpo));
    const erro = await criarApiHttp({ baseUrl: BASE, fetch })
      .listarProfissionais()
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroApi);
    expect((erro as ErroApi).message).toBe(texto);
    expect((erro as ErroApi).status).toBe(status);
  });

  it('400 cita só os nomes dos campos, nunca o valor', () => {
    const e = mensagemDeErro(400, { message: 'Dados inválidos', campos: ['telefone', 'cpf', 'telefone'], valor: '000.000.001-91' });
    expect(e.message).toBe('Confira telefone, CPF: algum dado não está certo.');
    expect(e.message).not.toContain('000');
  });

  it('401 avisa o provedor para limpar o retrato em memória', async () => {
    const aoPerderSessao = vi.fn();
    const { fetch } = simular(() => respostaJson(401, { statusCode: 401 }));
    await expect(criarApiHttp({ baseUrl: BASE, fetch, aoPerderSessao }).listarPacientes()).rejects.toThrow(MENSAGENS.sessao);
    expect(aoPerderSessao).toHaveBeenCalledOnce();
  });

  it('rede fora e timeout viram mensagens próprias', async () => {
    const rede = criarApiHttp({
      baseUrl: BASE,
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });
    await expect(rede.listarProfissionais()).rejects.toThrow(MENSAGENS.rede);

    const lento = criarApiHttp({
      baseUrl: BASE,
      timeoutMs: 20,
      fetch: ((_: unknown, init: RequestInit) =>
        new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('abortado', 'AbortError'))))) as unknown as typeof fetch,
    });
    await expect(lento.listarProfissionais()).rejects.toThrow(MENSAGENS.demorou);
  });

  it('o adaptador não tem console nem storage (sem log de dado pessoal)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const codigo = readFileSync(fileURLToPath(new URL('./http.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/\bconsole\.|localStorage|sessionStorage|indexedDB|document\.cookie|x-tenant|x-clinica/i);
  });
});

describe('seleção do adaptador', () => {
  it('padrão é fake; http exige origem válida; produção só https', () => {
    expect(lerConfigApi({})).toEqual({ modo: 'fake' });
    expect(lerConfigApi({ NEXT_PUBLIC_API_MODO: 'http', NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:3333' })).toEqual({
      modo: 'http',
      origem: 'http://127.0.0.1:3333',
    });
    expect(() => lerConfigApi({ NEXT_PUBLIC_API_MODO: 'http' })).toThrow();
    expect(() => lerConfigApi({ NEXT_PUBLIC_API_MODO: 'http', NEXT_PUBLIC_API_ORIGIN: 'http://api.test', NODE_ENV: 'production' })).toThrow();
    expect(() => lerConfigApi({ NEXT_PUBLIC_API_MODO: 'outro' })).toThrow();
  });

  it('modo http: pacientes/agenda vão à API; o resto continua no fake', async () => {
    const { chamadas, fetch } = simular(() => respostaJson(200, []));
    const api = criarApi({ modo: 'http', origem: BASE }, { http: { fetch } });
    await api.listarProfissionais();
    expect(chamadas).toHaveLength(1);
    expect((await api.listarRecibos()).length).toBeGreaterThan(0);
    expect(chamadas).toHaveLength(1);
  });

  it('retrato em memória: só id, nome, nome social, telefone, fim do CPF e situação (R1a)', () => {
    const p = paraIndice({
      id: 'p1',
      nome: 'Ficticia',
      nomeSocial: 'Fic',
      telefone: '(11) 90000-0001',
      cpf: '000.000.001-91',
      nascimento: '1990-01-01',
      responsaveis: [{ nome: 'R', parentesco: 'Mãe', telefone: '(11) 90000-0002' }],
      ativo: true,
      ficticio: true,
    });
    expect(p).toMatchObject({ cpf: '0191', nascimento: '', responsaveis: [] });
  });
});
