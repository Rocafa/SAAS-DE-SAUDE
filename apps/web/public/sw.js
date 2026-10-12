/*
 * Service worker do app (PWA). Guarda SÓ a tela "sem conexão" e os arquivos estáticos do build
 * (JS, CSS, fontes, ícones). NUNCA guarda páginas com dados nem respostas da API: dado de paciente
 * não fica no aparelho (LGPD). Sem internet, qualquer tela mostra o aviso de sem conexão.
 */
const CACHE = 'plataforma-saude-v1';
const OFFLINE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
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
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icones/')) {
    event.respondWith(
      caches.match(req).then(
        (r) =>
          r ||
          fetch(req).then((res) => {
            const copia = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copia));
            return res;
          }),
      ),
    );
  }
});
