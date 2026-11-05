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
