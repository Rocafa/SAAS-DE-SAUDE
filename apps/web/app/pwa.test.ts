/**
 * PWA: a equipe e o paciente instalam apps diferentes, e o service worker não pode servir arquivo de
 * um build antigo depois de um deploy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import manifestDaEquipe from './manifest';
import { GET as manifestoDoPortal } from './portal.webmanifest/route';

const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

describe('manifestos', () => {
  it('a equipe abre na área da equipe', () => {
    const m = manifestDaEquipe();
    expect(m.start_url).toBe('/inicio');
  });

  it('o portal tem manifesto próprio, com escopo e início dentro do portal', async () => {
    const corpo = (await (await manifestoDoPortal()).json()) as { start_url: string; scope: string; icons: unknown[] };
    expect(corpo.start_url).toBe('/portal');
    expect(corpo.scope).toBe('/portal');
    expect(corpo.icons.length).toBeGreaterThan(0);
  });
});

describe('service worker - código-fonte', () => {
  it('o nome do cache sai da versão do build, não de um número escrito à mão', () => {
    expect(sw).not.toMatch(/plataforma-saude-v\d/);
    expect(sw).toMatch(/searchParams\.get\('v'\)/);
  });

  it('só guarda resposta boa (404 não entra no cache)', () => {
    expect(sw).toMatch(/res\.ok/);
  });

  it('usa cache dinâmico baseado na query string ?v=', () => {
    expect(sw).toMatch(/const VERSAO = new URL\(self\.location\.href\)\.searchParams\.get\('v'\) \|\| 'dev'/);
    expect(sw).toMatch(/const CACHE = `plataforma-saude-\$\{VERSAO\}`/);
  });

  it('apaga caches antigos no activate', () => {
    expect(sw).toMatch(/caches\.keys\(\).then\(\(keys\) =>/);
    expect(sw).toMatch(/\.filter\(\(k\) => k !== CACHE\)/);
    expect(sw).toMatch(/caches\.delete\(k\)/);
  });

  it('não cacheia navegações (páginas com dados) — só a tela offline', () => {
    expect(sw).toMatch(/req\.mode === 'navigate'/);
    expect(sw).toMatch(/caches\.match\(OFFLINE\)/);
    // No bloco de navegação, não deve ter cache.put
    const fetchHandler = sw.substring(sw.indexOf("self.addEventListener('fetch'"));
    const navigateBlock = fetchHandler.substring(
      fetchHandler.indexOf("req.mode === 'navigate'"),
      fetchHandler.indexOf('return;', fetchHandler.indexOf("req.mode === 'navigate'"))
    );
    expect(navigateBlock).not.toMatch(/cache\.put/);
    expect(navigateBlock).not.toMatch(/caches\.open\(CACHE\)\.then\(\(c\) => c\.put/);
  });

  it('só cacheia arquivos estáticos permitidos (_next/static, icones, manifest)', () => {
    expect(sw).toMatch(/_next\/static/);
    expect(sw).toMatch(/\/icones\//);
    expect(sw).toMatch(/\/manifest\.webmanifest/);
    // Não deve cachear API ou páginas dinâmicas
    expect(sw).not.toMatch(/\/api\//);
    expect(sw).not.toMatch(/pacientes/);
    expect(sw).not.toMatch(/atendimento/);
  });

  it('pré-carrega recursos da página offline (CSS, JS, fontes, ícones) no install', () => {
    expect(sw).toMatch(/precarregarRecursosOffline/);
    expect(sw).toMatch(/extrairRecursosOffline/);
    expect(sw).toMatch(/stylesheet\|preload/);
    expect(sw).toMatch(/script\s+src=/);
  });
});

/*
 * Comportamento real: carrega o `public/sw.js` num contexto isolado (`vm`), com um `self` falso que
 * guarda os `addEventListener`, um Cache Storage em memória e uma rede falsa. Os eventos install,
 * activate e fetch são disparados como o navegador faria e o teste confere o que ficou no cache e o
 * que foi respondido. Só dados fictícios.
 */
const ORIGEM = 'https://clinica-ficticia.test';
const PERMITIDOS_NO_CACHE = [/^\/offline$/, /^\/_next\/static\//, /^\/icones\//, /^\/manifest\.webmanifest$/];

const HTML_OFFLINE = `<!doctype html><html><head>
  <link rel="stylesheet" href="/_next/static/css/app.css">
  <link rel="preload" href="/_next/static/media/fonte.woff2" as="font">
  <script src="/_next/static/chunks/app.js"></script>
  <link rel="icon" href="/icones/icone-192.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <script src="https://cdn.terceiro.test/rastreador.js"></script>
  <link rel="stylesheet" href="/api/pacientes/estilo.css">
</head><body>Sem conexão</body></html>`;

type Rota = (url: string) => Response | Promise<Response>;
type Ouvinte = (evento: unknown) => void;
interface Pedido { url: string; method: string; mode: string }

class CacheFalso {
  readonly itens = new Map<string, Response>();
  constructor(private readonly rede: (entrada: string | Pedido) => Promise<Response>) {}
  private chave(entrada: string | Pedido) {
    return new URL(typeof entrada === 'string' ? entrada : entrada.url, ORIGEM).href;
  }
  async add(entrada: string | Pedido) {
    const res = await this.rede(entrada);
    if (!res.ok) throw new TypeError(`add falhou: ${res.status}`);
    this.itens.set(this.chave(entrada), res);
  }
  async put(entrada: string | Pedido, res: Response) {
    this.itens.set(this.chave(entrada), res);
  }
  async match(entrada: string | Pedido) {
    return this.itens.get(this.chave(entrada))?.clone();
  }
}

function carregarSw(opcoes: { versao?: string; rotas?: Record<string, Rota>; cachesExistentes?: string[] } = {}) {
  const rotas: Record<string, Rota> = {
    '/offline': () => new Response(HTML_OFFLINE, { status: 200 }),
    ...opcoes.rotas,
  };
  const rede = vi.fn(async (entrada: string | Pedido) => {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url, ORIGEM);
    const rota = rotas[url.origin === ORIGEM ? url.pathname : url.href];
    return rota ? rota(url.href) : new Response('recurso fictício', { status: 200 });
  });
  const armazenamento = new Map<string, CacheFalso>();
  for (const nome of opcoes.cachesExistentes ?? []) armazenamento.set(nome, new CacheFalso(rede));
  const caches = {
    open: vi.fn(async (nome: string) => {
      if (!armazenamento.has(nome)) armazenamento.set(nome, new CacheFalso(rede));
      return armazenamento.get(nome)!;
    }),
    keys: vi.fn(async () => [...armazenamento.keys()]),
    delete: vi.fn(async (nome: string) => armazenamento.delete(nome)),
    match: vi.fn(async (entrada: string | Pedido) => {
      for (const cache of armazenamento.values()) {
        const achado = await cache.match(entrada);
        if (achado) return achado;
      }
      return undefined;
    }),
  };
  const ouvintes: Record<string, Ouvinte> = {};
  const self = {
    location: new URL(`${ORIGEM}/sw.js${opcoes.versao ? `?v=${opcoes.versao}` : ''}`),
    addEventListener: (tipo: string, fn: Ouvinte) => { ouvintes[tipo] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  vm.runInNewContext(sw, { self, caches, fetch: rede, URL, Response }, { filename: 'sw.js' });

  async function ciclo(tipo: 'install' | 'activate') {
    const pendentes: Promise<unknown>[] = [];
    ouvintes[tipo]!({ waitUntil: (p: Promise<unknown>) => pendentes.push(p) });
    await Promise.all(pendentes);
  }
  async function buscar(caminho: string, init: { method?: string; mode?: string } = {}) {
    let resposta: Promise<Response> | undefined;
    const request: Pedido = { url: new URL(caminho, ORIGEM).href, method: init.method ?? 'GET', mode: init.mode ?? 'cors' };
    ouvintes.fetch!({ request, respondWith: (p: Promise<Response>) => { resposta = p; } });
    const res = resposta ? await resposta : undefined;
    await new Promise((r) => setTimeout(r, 0)); // deixa o `caches.open(...).then(put)` do sw terminar
    return res;
  }
  const conteudo = (nome: string) => [...(armazenamento.get(nome)?.itens.keys() ?? [])].map((u) => new URL(u).pathname);
  const tudoNoCache = () => [...armazenamento.values()].flatMap((c) => [...c.itens.keys()]);
  const urlsBuscadas = () => rede.mock.calls.map(([e]) => new URL(typeof e === 'string' ? e : e.url, ORIGEM).href);
  return { self, caches, rede, ciclo, buscar, conteudo, tudoNoCache, urlsBuscadas, nomes: () => [...armazenamento.keys()] };
}

describe('service worker - comportamento (sw.js carregado de verdade)', () => {
  it('install pré-carrega /offline e só os estáticos da nossa origem citados nela', async () => {
    const sw = carregarSw({ versao: 'build123' });
    await sw.ciclo('install');

    expect(sw.nomes()).toEqual(['plataforma-saude-build123']);
    expect(sw.conteudo('plataforma-saude-build123').sort()).toEqual([
      '/_next/static/chunks/app.js',
      '/_next/static/css/app.css',
      '/_next/static/media/fonte.woff2',
      '/icones/icone-192.png',
      '/manifest.webmanifest',
      '/offline',
    ]);
    // Terceiro e caminho fora da lista permitida nem são buscados.
    expect(sw.urlsBuscadas()).not.toContain('https://cdn.terceiro.test/rastreador.js');
    expect(sw.urlsBuscadas()).not.toContain(`${ORIGEM}/api/pacientes/estilo.css`);
    // /offline vai à rede uma vez só (o HTML é lido do cache depois do `cache.add`).
    expect(sw.urlsBuscadas().filter((u) => u === `${ORIGEM}/offline`)).toHaveLength(1);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it('install sem ?v= usa o cache "dev"; recurso com erro não entra no cache', async () => {
    const sw = carregarSw({ rotas: { '/_next/static/css/app.css': () => new Response('x', { status: 404 }) } });
    await sw.ciclo('install');
    expect(sw.nomes()).toEqual(['plataforma-saude-dev']);
    expect(sw.conteudo('plataforma-saude-dev')).not.toContain('/_next/static/css/app.css');
    expect(sw.conteudo('plataforma-saude-dev')).toContain('/offline');
  });

  it('activate apaga os caches de builds anteriores e mantém só o atual', async () => {
    const sw = carregarSw({ versao: 'build3', cachesExistentes: ['plataforma-saude-build1', 'plataforma-saude-build2'] });
    await sw.ciclo('install');
    await sw.ciclo('activate');
    expect(sw.nomes()).toEqual(['plataforma-saude-build3']);
    expect(sw.caches.delete).toHaveBeenCalledWith('plataforma-saude-build1');
    expect(sw.caches.delete).toHaveBeenCalledWith('plataforma-saude-build2');
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });

  it('POST não é interceptado nem cacheado', async () => {
    const sw = carregarSw({ versao: 'b1' });
    await sw.ciclo('install');
    const antes = sw.tudoNoCache().length;
    const chamadasAntes = sw.rede.mock.calls.length;
    expect(await sw.buscar('/api/pacientes', { method: 'POST' })).toBeUndefined();
    expect(await sw.buscar('/_next/static/chunks/novo.js', { method: 'POST' })).toBeUndefined();
    expect(sw.rede.mock.calls.length).toBe(chamadasAntes);
    expect(sw.tudoNoCache().length).toBe(antes);
  });

  it('navegação sem internet cai em /offline', async () => {
    const sw = carregarSw({ versao: 'b1', rotas: { '/inicio': () => Promise.reject(new TypeError('sem rede')) } });
    await sw.ciclo('install');
    const res = await sw.buscar('/inicio', { mode: 'navigate' });
    expect(res).toBeDefined();
    expect(await res!.text()).toContain('Sem conexão');
  });

  it('página com dado de paciente não entra no cache, nem para outra clínica ver sem internet', async () => {
    // Clínica A abre o prontuário de um paciente fictício com internet...
    let online = true;
    const sw = carregarSw({
      versao: 'b1',
      rotas: {
        '/pacientes/pac-ficticio-a': () =>
          online ? new Response('Prontuário de Fulano Ficticio (clinica A)', { status: 200 }) : Promise.reject(new TypeError('sem rede')),
        '/api/pacientes': () => new Response('[{"nome":"Fulano Ficticio"}]', { status: 200 }),
      },
    });
    await sw.ciclo('install');
    const pagina = await sw.buscar('/pacientes/pac-ficticio-a', { mode: 'navigate' });
    expect(await pagina!.text()).toContain('Fulano Ficticio');
    // ...e a API é chamada direto, sem o sw responder.
    expect(await sw.buscar('/api/pacientes')).toBeUndefined();

    // Sem internet, quem abrir a mesma URL (ex.: outra clínica no mesmo aparelho) só vê o aviso genérico.
    online = false;
    const offline = await sw.buscar('/pacientes/pac-ficticio-a', { mode: 'navigate' });
    const texto = await offline!.text();
    expect(texto).toContain('Sem conexão');
    expect(texto).not.toContain('Fulano Ficticio');

    for (const url of sw.tudoNoCache()) {
      const { origin, pathname } = new URL(url);
      expect(origin).toBe(ORIGEM);
      expect(PERMITIDOS_NO_CACHE.some((re) => re.test(pathname)), `fora da lista: ${pathname}`).toBe(true);
    }
  });

  it('estático: cache-first, guarda resposta boa e não guarda 404', async () => {
    const sw = carregarSw({
      versao: 'b1',
      rotas: { '/_next/static/chunks/quebrado.js': () => new Response('não achou', { status: 404 }) },
    });
    await sw.ciclo('install');

    await sw.buscar('/_next/static/chunks/pagina.js');
    expect(sw.conteudo('plataforma-saude-b1')).toContain('/_next/static/chunks/pagina.js');
    const chamadas = sw.rede.mock.calls.length;
    expect(await (await sw.buscar('/_next/static/chunks/pagina.js'))!.text()).toBe('recurso fictício');
    expect(sw.rede.mock.calls.length).toBe(chamadas); // veio do cache, sem rede

    const res404 = await sw.buscar('/_next/static/chunks/quebrado.js');
    expect(res404!.status).toBe(404);
    expect(sw.conteudo('plataforma-saude-b1')).not.toContain('/_next/static/chunks/quebrado.js');
  });

  it('não intercepta outra origem', async () => {
    const sw = carregarSw({ versao: 'b1' });
    await sw.ciclo('install');
    expect(await sw.buscar('https://cdn.terceiro.test/_next/static/x.js')).toBeUndefined();
    expect(sw.tudoNoCache().some((u) => u.startsWith('https://cdn.terceiro.test'))).toBe(false);
  });
});
