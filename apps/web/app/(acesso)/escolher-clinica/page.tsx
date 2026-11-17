'use client';

import { Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

const CLINICAS = [
  { id: 'c1', nome: 'Clínica Demonstração', papel: 'Administrador' },
  { id: 'c2', nome: 'Consultório Exemplo (fictício)', papel: 'Profissional' },
];

export default function PaginaEscolherClinica() {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Em qual clínica você vai trabalhar agora?</h1>
      <p className="text-texto-suave">Os dados de cada clínica ficam separados. Dá para trocar depois.</p>
      <ul className="flex flex-col gap-2">
        {CLINICAS.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => router.push('/inicio')} className="flex min-h-16 w-full items-center gap-3 rounded-md border-2 border-borda-forte px-4 text-left">
              <Building2 aria-hidden className="size-6" />
              <span className="flex flex-col">
                <span className="text-lg font-bold">{c.nome}</span>
                <span className="text-texto-suave">{c.papel}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
