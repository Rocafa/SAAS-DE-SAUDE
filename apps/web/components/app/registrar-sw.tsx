'use client';

import { useEffect } from 'react';

/**
 * Registra o service worker (só em produção). Ver public/sw.js: não guarda dado de paciente.
 * A versão do build vai na URL: `/sw.js?v=<build>` muda o arquivo registrado a cada deploy, então o
 * navegador reinstala o service worker e o cache antigo é apagado no `activate`.
 */
export function RegistrarServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const versao = process.env.NEXT_PUBLIC_BUILD_ID?.trim() || 'dev';
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(versao)}`).catch(() => {
      /* sem PWA o app funciona igual */
    });
  }, []);
  return null;
}
