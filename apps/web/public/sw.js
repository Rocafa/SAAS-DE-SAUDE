/*
 * Service worker do app (PWA). Guarda SÓ a tela "sem conexão" e os arquivos estáticos do build
 * (JS, CSS, fontes, ícones). NUNCA guarda páginas com dados nem respostas da API: dado de paciente
 * não fica no aparelho (LGPD). Sem internet, qualquer tela mostra o aviso de sem conexão.
 */
// A versão vem da URL com que o service worker foi registrado (`/sw.js?v=<build>`): URL nova é
// service worker novo, então o navegador reinstala e o `activate` apaga o cache do build anterior.
// Sem isso, o cache fica preso ao primeiro build para sempre e a tela "sem conexão" aparece com CSS
// de uma versão que já não existe.
const VERSAO = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `plataforma-saude-${VERSAO}`;
const OFFLINE = '/offline';

/**
 * Extrai URLs de recursos (CSS, JS, fontes, ícones) do HTML da página offline.
 * Usa regex simples pois o HTML é controlado por nós e bem formado.
 */
function extrairRecursosOffline(html) {
  const urls = new Set();
  // <link rel="stylesheet" href="..."> | <link rel="preload" href="..." as="style"> | <link rel="preload" href="..." as="font">
  const linkRegex = /<link\s+[^>]*rel=(["'])?(?:stylesheet|preload)\1[^>]*href=(["'])([^"']+)\2/gi;
  // <script src="..."></script> | <script src="..." async></script>
  const scriptRegex = /<script\s+[^>]*src=(["'])([^"']+)\1/gi;
  // <link rel="icon" href="..."> | <link rel="apple-touch-icon" href="..."> | <link rel="manifest" href="...">
  const iconRegex = /<link\s+[^>]*rel=(["'])(?:icon|apple-touch-icon|manifest)\1[^>]*href=(["'])([^"']+)\2/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    urls.add(match[3]);
  }
  while ((match = scriptRegex.exec(html)) !== null) {
    urls.add(match[2]);
  }
  while ((match = iconRegex.exec(html)) !== null) {
    urls.add(match[3]);
  }

  // Filtrar só recursos da nossa origem e estáticos
  return Array.from(urls).filter((u) => {
    try {
      const url = new URL(u, self.location.origin);
      return url.origin === self.location.origin &&
        (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icones/') || url.pathname === '/manifest.webmanifest');
    } catch {
      return false;
    }
  });
}

/**
 * Pré-carrega os recursos críticos da página offline durante a instalação.
 */
async function precarregarRecursosOffline(cache) {
  try {
    // Lê o HTML do cache (o `cache.add` acabou de guardar): evita buscar /offline duas vezes na rede.
    const resp = await cache.match(OFFLINE);
    if (!resp) return;
    const html = await resp.text();
    const recursos = extrairRecursosOffline(html);
    await Promise.all(
      recursos.map((url) =>
        fetch(url, { credentials: 'same-origin' })
          .then((r) => r.ok && cache.put(url, r.clone()))
          .catch(() => { /* ignora falhas individuais */ }),
      ),
    );
  } catch {
    // Se falhar ao buscar a página offline, segue sem pré-carregar (o cache on-demand cuida depois)
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.add(OFFLINE);
      await precarregarRecursosOffline(cache);
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icones/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            // 404 e erro não entram no cache: guardado uma vez, ficaria servindo o erro.
            if (res.ok) {
              const copia = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copia));
            }
            return res;
          }),
      ),
    );
  }
});