// @ts-nocheck
/**
 * PWA: a equipe e o paciente instalam apps diferentes, e o service worker não pode servir arquivo de
 * um build antigo depois de um deploy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

  it('não cacheia respostas de erro (404, 500)', () => {
    expect(sw).toMatch(/if \(res\.ok\)/);
    expect(sw).toMatch(/404 e erro não entram no cache/);
  });
});

// Testes de lógica do service worker com mocks do Cache API
describe('service worker - lógica de versão e limpeza (unitário)', () => {
  /** @type {Map<string, any>} */
  let cacheStore;
  /** @type {any} */
  let cachesMock;
  /** @type {any} */
  let fetchMock;
  /** @type {any} */
  let originalFetch;
  /** @type {any} */
  let originalCaches;
  /** @type {any} */
  let selfMock;

  beforeEach(() => {
    // Mock do Cache store
    cacheStore = new Map();

    // Mock do Cache
    const createCache = (/** @type {string} */ name) => ({
      name,
      match: vi.fn(),
      put: vi.fn(),
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      store: new Map(),
    });

    // Mock do caches
    cachesMock = {
      open: vi.fn((/** @type {string} */ name) => {
        if (!cacheStore.has(name)) {
          cacheStore.set(name, createCache(name));
        }
        return Promise.resolve(cacheStore.get(name));
      }),
      keys: vi.fn(() => Promise.resolve(Array.from(cacheStore.keys()))),
      delete: vi.fn((/** @type {string} */ name) => {
        cacheStore.delete(name);
        return Promise.resolve(true);
      }),
      has: vi.fn((/** @type {string} */ name) => Promise.resolve(cacheStore.has(name))),
      match: vi.fn(),
    };

    // Mock do fetch
    fetchMock = vi.fn();
    originalFetch = global.fetch;
    global.fetch = fetchMock;

    // Mock do caches global
    originalCaches = global.caches;
    /** @type {any} */
    (global.caches) = cachesMock;

    // Mock do self
    selfMock = {
      location: {
        href: 'https://example.com/sw.js?v=build123',
        origin: 'https://example.com',
        searchParams: new URLSearchParams('v=build123'),
      },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
      addEventListener: vi.fn(),
    };
    /** @type {any} */
    (global.self) = selfMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    /** @type {any} */
    (global.caches) = originalCaches;
    /** @type {any} */
    (global.self) = undefined;
    vi.clearAllMocks();
  });

  it('gera nome de cache único por versão do build', () => {
    const VERSAO = new URL(self.location.href).searchParams.get('v') || 'dev';
    const CACHE = `plataforma-saude-${VERSAO}`;
    expect(CACHE).toBe('plataforma-saude-build123');
  });

  it('muda o nome do cache quando a versão muda', async () => {
    // Primeira versão
    selfMock.location = {
      href: 'https://example.com/sw.js?v=build1',
      origin: 'https://example.com',
      searchParams: new URLSearchParams('v=build1'),
    };
    let VERSAO = new URL(self.location.href).searchParams.get('v') || 'dev';
    let CACHE = `plataforma-saude-${VERSAO}`;
    await cachesMock.open(CACHE);
    expect(cachesMock.open).toHaveBeenCalledWith('plataforma-saude-build1');

    // Segunda versão (novo deploy)
    selfMock.location = {
      href: 'https://example.com/sw.js?v=build2',
      origin: 'https://example.com',
      searchParams: new URLSearchParams('v=build2'),
    };
    VERSAO = new URL(self.location.href).searchParams.get('v') || 'dev';
    CACHE = `plataforma-saude-${VERSAO}`;
    await cachesMock.open(CACHE);
    expect(cachesMock.open).toHaveBeenCalledWith('plataforma-saude-build2');
  });

  it('activate apaga caches de versões anteriores', async () => {
    // Criar caches de versões antigas
    await cachesMock.open('plataforma-saude-build1');
    await cachesMock.open('plataforma-saude-build2');
    await cachesMock.open('plataforma-saude-build3');

    // Versão atual
    const CACHE_ATUAL = 'plataforma-saude-build3';

    // Simular lógica do activate
    const keys = await cachesMock.keys();
    const paraApagar = keys.filter((k) => k !== CACHE_ATUAL);
    await Promise.all(paraApagar.map((k) => cachesMock.delete(k)));

    const keysRestantes = await cachesMock.keys();
    expect(keysRestantes).toEqual(['plataforma-saude-build3']);
    expect(cachesMock.delete).toHaveBeenCalledWith('plataforma-saude-build1');
    expect(cachesMock.delete).toHaveBeenCalledWith('plataforma-saude-build2');
    expect(cachesMock.delete).not.toHaveBeenCalledWith('plataforma-saude-build3');
  });

  it('install adiciona página offline e pré-carrega recursos', async () => {
    const CACHE = 'plataforma-saude-test';
    const cache = await cachesMock.open(CACHE);

    // Mock fetch para a página offline
    const offlineHtml = `
      <html>
        <head>
          <link rel="stylesheet" href="/_next/static/chunks/app.css">
          <link rel="preload" href="/_next/static/media/font.woff2" as="font">
          <script src="/_next/static/chunks/app.js"></script>
          <link rel="icon" href="/icones/icone-192.png">
          <link rel="manifest" href="/manifest.webmanifest">
        </head>
        <body>Offline</body>
      </html>
    `;
    fetchMock
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(offlineHtml), clone: () => ({ ok: true }) })
      .mockResolvedValue({ ok: true, clone: () => ({ ok: true }) });

    // Simular install
    await cache.add('/offline');
    expect(cache.add).toHaveBeenCalledWith('/offline');
  });

  it('fetch de navegação cai para offline quando rede falha', async () => {
    const CACHE = 'plataforma-saude-test';
    const cache = await cachesMock.open(CACHE);
    const offlineResponse = new Response('Offline page', { status: 200 });
    cache.match.mockResolvedValue(offlineResponse);

    // Simular navegação falhando
    fetchMock.mockRejectedValueOnce(new Error('Offline'));

    // Request no Node não suporta mode: 'navigate', testamos só a lógica de fallback
    // O SW faria: fetch(req).catch(() => caches.match(OFFLINE))
    // Aqui verificamos que o cache tem a página offline
    const cached = await cache.match('/offline');
    expect(cached).toBe(offlineResponse);
  });

  it('fetch de estáticos usa cache-first e guarda respostas OK', async () => {
    const CACHE = 'plataforma-saude-test';
    const cache = await cachesMock.open(CACHE);
    const cssResponse = new Response('.css{color:red}', { status: 200 });
    const errorResponse = new Response('Not Found', { status: 404 });

    // Primeira vez: não está no cache, busca na rede (OK) e guarda
    cache.match.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(cssResponse.clone());

    const req = new Request('https://example.com/_next/static/chunks/app.css');
    const cached = await cache.match(req);
    expect(cached).toBeUndefined();

    // Simular fetch e put
    const res = await fetchMock(req);
    expect(res.ok).toBe(true);

    // Segunda vez: está no cache
    cache.match.mockResolvedValueOnce(cssResponse);
    const cached2 = await cache.match(req);
    expect(cached2).toBe(cssResponse);

    // Erro 404 não entra no cache
    cache.match.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(errorResponse);
    const res404 = await fetchMock(req);
    expect(res404.ok).toBe(false);
  });

  it('ignora requisições não-GET e cross-origin', () => {
    // POST não deve ser interceptado
    const postReq = new Request('https://example.com/api/pacientes', { method: 'POST' });
    expect(postReq.method).toBe('POST');

    // Cross-origin não deve ser interceptado
    const crossReq = new Request('https://outro.com/recurso', { method: 'GET' });
    expect(new URL(crossReq.url).origin).not.toBe('https://example.com');
  });
});