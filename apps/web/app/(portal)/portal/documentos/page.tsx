'use client';

/** Portal: meus documentos (recibos). A impressão sai só com a folha do recibo escolhido. */
import { FileText, Printer } from 'lucide-react';
import { useState } from 'react';
import { useConsultaPortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import type { ReciboPortal } from '@/lib/api/portal';
import { NOME_FORMA } from '@/lib/financeiro';
import { reais } from '@/lib/utils';

export default function PortalDocumentos() {
  const consulta = useConsultaPortal((a) => a.meusRecibos());
  const [folha, setFolha] = useState<ReciboPortal | null>(null);
  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Meus documentos</h1>
      <p className="mb-6 text-texto-suave">Recibos, atestados e declarações que a clínica liberou para você.</p>
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (consulta.dados.length === 0 ? (
          <Vazio titulo="Nenhum documento ainda" oQueFazer="Quando a clínica emitir um documento para você, ele aparece aqui." />
        ) : (
          <ul className="flex flex-col gap-2">
            {consulta.dados.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                <FileText aria-hidden className="size-6" />
                <span className="flex-1">
                  <strong>Recibo</strong> · {formatarDia(r.data, new Date())} · {reais(r.valor)} ({NOME_FORMA[r.forma]})
                </span>
                <Botao
                  variante="contorno"
                  tamanho="pequeno"
                  onClick={() => {
                    setFolha(r);
                    setTimeout(() => window.print(), 50);
                  }}
                >
                  <Printer aria-hidden />
                  Imprimir
                </Botao>
              </li>
            ))}
          </ul>
        ))}
      {folha && (
        <div data-imprimir className="sr-only print:not-sr-only">
          <p>Clínica Demonstração</p>
          <h2>Recibo</h2>
          <p>{folha.texto}</p>
        </div>
      )}
    </>
  );
}
