'use client';

import type { ReactNode } from 'react';
import { Ajudante } from '@/components/app/ajudante';
import { DadosProvider } from '@/components/app/dados';
import { AvisosProvider } from '@/components/app/desfazer';
import { Estrutura } from '@/components/app/estrutura';
import { ExecutorProvider } from '@/components/app/executor';

export default function LayoutLogado({ children }: { children: ReactNode }) {
  return (
    <DadosProvider>
      <AvisosProvider>
        <ExecutorProvider>
          <Estrutura>{children}</Estrutura>
          <Ajudante />
        </ExecutorProvider>
      </AvisosProvider>
    </DadosProvider>
  );
}
