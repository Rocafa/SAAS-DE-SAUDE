import type { MetadataRoute } from 'next';

/**
 * Manifesto do PORTAL DO PACIENTE, separado do da equipe: quem instala o portal no celular tem de
 * abrir em `/portal`, não na área da equipe. Vai como rota porque o layout do portal é componente de
 * cliente e `app/manifest.ts` só aceita um manifesto por aplicação.
 */
export function GET(): Response {
  const manifesto: MetadataRoute.Manifest = {
    name: 'Portal do paciente',
    short_name: 'Meu portal',
    description: 'Suas consultas, documentos e dados na clínica',
    lang: 'pt-BR',
    start_url: '/portal',
    scope: '/portal',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111111',
    icons: [
      { src: '/icones/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icones/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icones/icone-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return Response.json(manifesto, { headers: { 'Content-Type': 'application/manifest+json' } });
}
