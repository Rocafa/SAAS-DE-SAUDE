'use client';

import { useEffect, useState } from 'react';

/** Espera a pessoa parar de digitar antes de buscar no servidor (modo http). */
export function useAtrasado(valor: string, ms: number): string {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}
