import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMPOS_CLINICOS_PROIBIDOS,
  CONTRATO_PORTAL,
  PORTAL_ERROS_COMUNS,
  PORTAL_ERROS_DO_VINCULO,
  PORTAL_FORMAS_DE_PAGAMENTO,
  PORTAL_TIPOS_DE_PEDIDO,
  conferirRespostaPortal,
  type RotaPortal,
} from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { ErroPortal, mensagemDoErro, ROTAS, type ClientePortal } from './api/portal';
import { CODIGO_CONVITE_DEMONSTRACAO, TOKEN_CONVITE_DEMONSTRACAO, criarApiPortalFake } from './api/portal-fake';
import {
  centavosEmReais,
  dataBr,
  DIREITOS,
  direitosDoVinculo,
  mensagemNoVinculo,
  NOME_FORMA_PORTAL,
  permitido,
  prazoBr,
  tituloDoPedido,
  tituloDosDados,
  validarCorrecao,
} from './portal';

const hoje = new Date(2026, 9, 12, 10);
const raiz = fileURLToPath(new URL('..', import.meta.url));

async function falha(p: Promise<unknown>): Promise<ErroPortal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErroPortal) return e;
    throw e;
  }
  throw new Error('era para falhar');
}

describe('portal: regras de exibição', () => {
  it('"não respondido" vale como NÃO (ressalva R1 do Guardião)', () => {
    expect(permitido('sim')).toBe(true);
    expect(permitido('nao')).toBe(false);
    expect(permitido('nao_respondido')).toBe(false);
    expect(permitido(undefined)).toBe(false);
  });
  it('pedidos com os nomes canônicos do backend (P8), um texto para cada', () => {
    expect(DIREITOS.map((d) => d.tipo).sort()).toEqual([...PORTAL_TIPOS_DE_PEDIDO].sort());
  });
  it('textos sem jargão jurídico nem técnico', () => {
    for (const t of DIREITOS.map((d) => d.titulo + d.explicacao)) {
      expect(t).not.toMatch(/titular|controlador|tratamento de dados|tenant|registro de|submeter/i);
    }
  });
  it('apagar explica a guarda legal do prontuário', () => {
    expect(DIREITOS.find((d) => d.tipo === 'eliminacao')?.explicacao).toMatch(/prazo da lei/);
  });
  it('formas de pagamento com os nomes do banco e valor em centavos (P7)', () => {
    expect(Object.keys(NOME_FORMA_PORTAL).sort()).toEqual([...PORTAL_FORMAS_DE_PAGAMENTO].sort());
    expect(centavosEmReais(15050).replace(/\s/g, ' ')).toBe('R$ 150,50');
  });
  it('datas: nascimento como data de calendário e prazo do servidor sem recálculo', () => {
    expect(dataBr('2018-05-10')).toBe('10/05/2018');
    expect(prazoBr('2026-10-27')).toBe('27/10/2026');
    expect(prazoBr(new Date(2026, 9, 27, 12).toISOString())).toBe('27/10/2026');
  });
  it('responsável legal vê "Dados de <nome>", nunca "seus dados"', () => {
    expect(tituloDosDados('dados_do_paciente', 'Sofia')).toBe('Dados de Sofia');
    expect(tituloDosDados('meus_dados', 'Maria')).toBe('Meus dados');
  });
  it('responsável: direitos e pedidos falam do paciente, nunca "sobre mim"/"meus dados" (R1 do #75)', () => {
    const textos = direitosDoVinculo('Sofia').map((d) => d.titulo + ' ' + d.explicacao);
    for (const t of textos) expect(t).not.toMatch(/\bmim\b|\bmeus?\b|\bminhas?\b/i);
    expect(direitosDoVinculo('Sofia').find((d) => d.tipo === 'acesso')?.titulo).toBe('Ver quais dados a clínica tem sobre Sofia');
    expect(tituloDoPedido('portabilidade', 'Sofia')).toBe('Baixar uma cópia dos dados de Sofia');
    expect(tituloDoPedido('compartilhamento', 'Sofia')).toMatch(/dados de Sofia/);
    expect(tituloDoPedido('acesso')).toBe('Ver quais dados a clínica tem sobre mim');
    const msg = mensagemDoErro(409, 'nascimento_nao_informado');
    expect(mensagemNoVinculo(msg, true)).toMatch(/"Dados do paciente"/);
    expect(mensagemNoVinculo(msg, true)).not.toMatch(/Meus dados/);
    expect(mensagemNoVinculo(msg, false)).toBe(msg);
  });
  it('correção: detalhe ≥ 3 e data existente, não futura, desde 1900 (mesma regra do servidor)', () => {
    expect(validarCorrecao('  ', undefined, '2026-10-12')).toMatch(/o que está errado/);
    expect(validarCorrecao('ok!', undefined, '2026-10-12')).toBeNull();
    expect(validarCorrecao('data errada', '2027-02-30', '2026-10-12')).toMatch(/inválida/);
    expect(validarCorrecao('data errada', '2026-10-13', '2026-10-12')).toMatch(/Confira/);
    expect(validarCorrecao('data errada', '1899-12-31', '2026-10-12')).toMatch(/Confira/);
    expect(validarCorrecao('data errada', '2018-05-11', '2026-10-12')).toBeNull();
  });
});

describe('cliente do portal × contrato ApiPortal', () => {
  it('toda rota do contrato tem um método, e nenhum método fora do contrato', () => {
    expect(Object.values(ROTAS).sort()).toEqual((Object.keys(CONTRATO_PORTAL) as RotaPortal[]).sort());
  });
  it('todo código de erro do contrato tem mensagem própria para a tela', () => {
    const codigos = new Set<string>();
    for (const def of Object.values(CONTRATO_PORTAL)) for (const e of def.erros as readonly { codigo?: string }[]) if (e.codigo) codigos.add(e.codigo);
    for (const e of [...PORTAL_ERROS_COMUNS, ...PORTAL_ERROS_DO_VINCULO]) if (e.codigo) codigos.add(e.codigo);
    for (const c of codigos) expect(mensagemDoErro(409, c), c).not.toBe(mensagemDoErro(409));
  });
  it('mensagens de erro não citam id, rota nem dado', () => {
    for (const s of [400, 401, 403, 404, 409, 422, 429, 500, 0]) expect(mensagemDoErro(s)).not.toMatch(/\/portal|\bid\b|undefined/i);
  });
});

/** Respostas do fake conferidas contra o contrato estrito, para titular e responsável. */
async function respostasDoFake(api: ClientePortal): Promise<[RotaPortal, unknown][]> {
  const consultas = await api.consultas();
  const recibos = await api.recibos();
  const r: [RotaPortal, unknown][] = [
    ['GET /portal/vinculos', await api.vinculos()],
    ['GET /portal/sessao', await api.sessao()],
    ['GET /portal/consultas', consultas],
    ['GET /portal/recibos', recibos],
    ['GET /portal/documentos', await api.documentos()],
    ['GET /portal/meus-dados', await api.meusDados()],
    ['GET /portal/privacidade/consentimentos', await api.consentimentos()],
    ['POST /portal/privacidade/consentimentos/:finalidade', await api.responderConsentimento('pesquisa', 'sim')],
    ['GET /portal/privacidade/consentimentos/:finalidade/historico', await api.historicoConsentimento('pesquisa')],
    ['POST /portal/solicitacoes', await api.abrirPedido('acesso')],
    ['POST /portal/meus-dados/correcao', await api.pedirCorrecao({ detalhe: 'telefone mudou', nascimento: '2018-05-10' })],
    ['GET /portal/solicitacoes', await api.pedidos()],
  ];
  if (recibos[0]) r.push(['GET /portal/recibos/:id', await api.recibo(recibos[0].id)]);
  const c = consultas.find((x) => x.podeConfirmar);
  if (c) r.push(['POST /portal/consultas/:id/confirmar', await api.confirmarConsulta(c.id)]);
  return r;
}

function chavesProfundas(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(chavesProfundas);
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...chavesProfundas(x)]);
  return [];
}

describe('fake do portal: simula o servidor do contrato', () => {
  it.each(['titular', 'responsavel'] as const)('respostas do %s conferem o contrato estrito e não têm campo clínico', async (quem) => {
    const respostas = await respostasDoFake(criarApiPortalFake({ agora: hoje, vinculoInicial: quem }));
    expect(respostas.length).toBeGreaterThan(10);
    for (const [rota, corpo] of respostas) {
      expect(conferirRespostaPortal(rota, corpo), rota).toEqual([]);
      for (const k of chavesProfundas(corpo)) expect(CAMPOS_CLINICOS_PROIBIDOS as readonly string[], `${rota}.${k}`).not.toContain(k);
    }
  });

  it('consulta de outra pessoa: 404 igual a "não existe" (IDOR)', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    expect((await falha(api.confirmarConsulta('a07'))).status).toBe(404);
    expect((await falha(api.cancelarConsulta('nao-existe'))).status).toBe(404);
  });

  it('botões seguem os flags do servidor; confirmar se desfaz, cancelar não', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    const c = (await api.consultas()).find((x) => x.status === 'agendado' && x.podeConfirmar)!;
    expect(c.podeCancelar).toBe(true);
    expect(await api.confirmarConsulta(c.id)).toEqual({ status: 'confirmado' });
    const confirmada = (await api.consultas()).find((x) => x.id === c.id)!;
    expect([confirmada.podeConfirmar, confirmada.podeCancelar]).toEqual([false, true]);
    expect(await api.desfazerConfirmacao(c.id)).toEqual({ status: 'agendado' });
    expect(await api.cancelarConsulta(c.id)).toEqual({ status: 'cancelado' });
    const cancelada = (await api.consultas()).find((x) => x.id === c.id)!;
    expect([cancelada.podeConfirmar, cancelada.podeCancelar]).toEqual([false, false]);
    // O servidor não "descancela": desfazer só vale para confirmação.
    expect(await falha(api.desfazerConfirmacao(c.id))).toMatchObject({ status: 409, codigo: 'status_nao_permite' });
  });

  it('consentimento é histórico: desfazer grava evento novo; nada a desfazer dá 409', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    const ia = async () => (await api.consentimentos()).find((c) => c.finalidade === 'escriba_ia')!;
    expect((await ia()).resposta).toBe('nao_respondido');
    expect((await ia()).titulo).toMatch(/inteligência artificial/);
    await api.responderConsentimento('escriba_ia', 'sim');
    expect((await ia()).resposta).toBe('sim');
    await api.desfazerConsentimento('escriba_ia');
    expect((await ia()).resposta).toBe('nao_respondido');
    expect((await api.historicoConsentimento('escriba_ia')).map((e) => e.resposta)).toEqual(['sim', 'desfeito']);
    expect(await falha(api.desfazerConsentimento('escriba_ia'))).toMatchObject({ status: 409, codigo: 'nada_a_desfazer' });
  });

  it('pedido com protocolo e prazo do servidor e tipo canônico; correção exige detalhe e data válida', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    expect(await falha(api.pedirCorrecao({ detalhe: '  ' }))).toMatchObject({ status: 400, campos: ['detalhe'] });
    expect(await falha(api.pedirCorrecao({ detalhe: 'data errada', nascimento: '2027-02-30' }))).toMatchObject({ status: 400, campos: ['nascimento'] });
    const p = await api.abrirPedido('portabilidade');
    expect(p).toMatchObject({ tipo: 'portabilidade', situacao: 'aberto', resposta: null });
    expect(p.protocolo).toMatch(/^20261012-[0-9A-Z]{8}$/);
    expect((await api.pedirCorrecao({ detalhe: 'telefone mudou' })).tipo).toBe('correcao');
    expect(await api.pedidos()).toHaveLength(2);
  });

  it('"de quem": sem escolha dá 409 escolher_vinculo; a troca isola os dados de cada vínculo', async () => {
    const api = criarApiPortalFake({ agora: hoje, vinculoInicial: null });
    expect(await falha(api.sessao())).toMatchObject({ status: 409, codigo: 'escolher_vinculo' });
    expect(await falha(api.consultas())).toMatchObject({ status: 409, codigo: 'escolher_vinculo' });
    const vs = await api.vinculos();
    expect(vs.map((v) => v.agindoComo)).toEqual(['titular', 'responsavel_legal']);
    await api.escolherVinculo(vs[0]!.vinculoId);
    await api.abrirPedido('acesso');
    expect((await api.meusDados()).rotulo).toBe('meus_dados');
    const resp = await api.escolherVinculo(vs[1]!.vinculoId);
    expect(resp).toMatchObject({ agindoComo: 'responsavel_legal', primeiroNome: 'Sofia' });
    expect(await api.pedidos()).toEqual([]);
    const dados = await api.meusDados();
    expect(dados.rotulo).toBe('dados_do_paciente');
    expect(dados.nascimento).toBe('2018-05-10');
    expect(dados.cpfMascarado).toMatch(/^\*\*\*\.\*\*\*\./);
    expect(await falha(api.escolherVinculo('v-de-outra-conta'))).toMatchObject({ status: 404 });
  });

  it('convite: falha sempre igual; o código certo cria o vínculo e o escolhe na sessão', async () => {
    const api = criarApiPortalFake({ agora: hoje, semVinculos: true });
    expect(await falha(api.sessao())).toMatchObject({ status: 409, codigo: 'sem_vinculo' });
    expect(await falha(api.resgatarConvite('errado'))).toMatchObject({ status: 409, codigo: 'convite_invalido' });
    const desafio = await api.resgatarConvite(TOKEN_CONVITE_DEMONSTRACAO);
    expect(conferirRespostaPortal('POST /portal/convites/resgate', desafio)).toEqual([]);
    expect(desafio.destino).toMatch(/\*/);
    expect(await falha(api.confirmarConvite(TOKEN_CONVITE_DEMONSTRACAO, '000000'))).toMatchObject({ status: 409, codigo: 'convite_invalido' });
    const r = await api.confirmarConvite(TOKEN_CONVITE_DEMONSTRACAO, CODIGO_CONVITE_DEMONSTRACAO);
    expect(conferirRespostaPortal('POST /portal/convites/resgate/confirmar', r)).toEqual([]);
    expect((await api.sessao()).vinculoId).toBe(r.vinculoId);
  });
});

describe('B3 do Guardião e R-47a: portal separado da clínica', () => {
  const lista = (dir: string) =>
    readdirSync(join(raiz, dir), { recursive: true })
      .map((f) => join(raiz, dir, String(f)))
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));

  it('as telas do portal não usam o provedor nem o contrato da clínica, e não passam pacienteId', () => {
    const arquivos = [...lista('app/(portal)'), ...lista('components/portal'), ...lista('app/(acesso)/portal')];
    expect(arquivos.length).toBeGreaterThan(6);
    for (const f of arquivos) {
      const codigo = readFileSync(f, 'utf8');
      expect(codigo, f).not.toMatch(/components\/app\/dados|lib\/api\/cliente|lib\/api\/fake['"]|lib\/api\/http['"]|pacienteId|ApiClinica/);
    }
  });

  it('o cliente e o adaptador HTTP do portal não importam o fake, o contrato nem o HTTP da clínica', () => {
    for (const f of ['lib/api/portal.ts', 'lib/api/portal-http.ts']) {
      const codigo = readFileSync(join(raiz, f), 'utf8');
      expect(codigo, f).not.toMatch(/from ['"]\.\/(fake|cliente|http|tipos)['"]/);
      expect(codigo.replace(/\/\*[\s\S]*?\*\//g, ''), f).not.toMatch(/pacienteId|tenantId|x-tenant-id|x-paciente-id/i);
    }
  });

  it('nada do portal vai para console, armazenamento do navegador ou analytics; token do convite nunca da query', () => {
    const arquivos = [
      'lib/api/portal.ts',
      'lib/api/portal-http.ts',
      'lib/api/portal-selecionar.ts',
      'lib/portal.ts',
      'components/portal/dados-portal.tsx',
      'components/portal/resgate-convite.tsx',
      ...lista('app/(portal)').map((f) => f.slice(raiz.length)),
    ];
    for (const f of arquivos) {
      const codigo = readFileSync(join(raiz, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(codigo, f).not.toMatch(/\bconsole\.|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|gtag|dataLayer|posthog|sentry/i);
    }
    const convite = readFileSync(join(raiz, 'components/portal/resgate-convite.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(convite).not.toMatch(/location\.search|useSearchParams|searchParams/);
    expect(convite).toMatch(/history\.replaceState/);
  });
});
