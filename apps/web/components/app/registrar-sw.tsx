'use client';

import { useEffect } from 'react';

/** Registra o service worker (só em produção). Ver public/sw.js: não guarda dado de paciente. */
export function RegistrarServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* sem PWA o app funciona igual */
    });
  }, []);
  return null;
}
