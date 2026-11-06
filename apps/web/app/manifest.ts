import type { MetadataRoute } from 'next';

/** Manifesto do PWA: instala no celular como app. Só preto, branco e cinza. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Plataforma Saúde',
    short_name: 'Saúde',
    description: 'Gestão para clínicas e consultórios',
    lang: 'pt-BR',
    start_url: '/inicio',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111111',
    icons: [
      { src: '/icones/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icones/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icones/icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
