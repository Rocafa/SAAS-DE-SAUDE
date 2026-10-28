import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible } from 'next/font/google';
import type { ReactNode } from 'react';
import { RegistrarServiceWorker } from '@/components/app/registrar-sw';
import './globals.css';

// Fonte feita para leitura fácil (baixa visão). next/font baixa no build e serve da própria origem:
// nenhuma requisição a CDN no navegador, compatível com a CSP (font-src 'self').
const fonte = Atkinson_Hyperlegible({
  weight: ['400', '700'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--fonte-texto',
});

export const metadata: Metadata = {
  title: 'Plataforma Saúde',
  description: 'Gestão para clínicas e consultórios',
  icons: { icon: '/icones/icone-192.png', apple: '/icones/icone-192.png' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0b0b' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={fonte.variable}>
      <body className="min-h-screen font-sans antialiased">
        {children}
        <RegistrarServiceWorker />
      </body>
    </html>
  );
}
