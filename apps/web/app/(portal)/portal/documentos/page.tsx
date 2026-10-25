'use client';

/**
 * Portal: documentos (recibos). A lista vem em CENTAVOS (P7). A folha é montada só quando o paciente
 * pede para imprimir, a partir de `GET /portal/recibos/:id` (retrato emitido): nada é pré-carregado nem
 * guardado, a folha sai do estado depois da impressão (afterprint, matchMedia ou limite de tempo), fica fora do
 * leitor de tela (aria-hidden), e o recibo não ganha enriquecimento nenhum
 * (especialidade, ícone ou cor por área; §10h).
 */
import { FileText, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConsultaPortal, usePortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import type { ReciboPortal } from '@/lib/api/portal';
import { centavosEmReais, dataBr, NOME_FORMA_PORTAL } from '@/lib/portal';
import { imprimirELimpar } from '@/lib/portal-impressao';

export default function PortalDocumentos() {
  const { api } = usePortal();
  const consulta = useConsultaPortal(async (a) => {
    const [recibos, documentos] = await Promise.all([a.recibos(), a.documentos()]);
    return { recibos, documentos };
  });
  const [folha, setFolha] = useState<ReciboPortal | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!folha) return;
    // R2 (#75): sai da página no afterprint, no fim do matchMedia('print') ou no limite de tempo.
    return imprimirELimpar(window, () => setFolha(null));
  }, [folha]);

  async function imprimir(id: string) {
    try {
      setErro('');
      setFolha(await api.recibo(id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não deu para abrir o recibo.');
    }
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Documentos</h1>
      <p className="mb-6 text-texto-suave">Recibos que a clínica emitiu.</p>
      {erro && (
        <p role="alert" className="mb-4 font-bold">
          ⚠ {erro}
        </p>
      )}
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' && (
        <>
          {consulta.dados.recibos.length === 0 ? (
            <Vazio titulo="Nenhum recibo ainda" oQueFazer="Quando a clínica emitir um recibo, ele aparece aqui." />
          ) : (
            <ul className="flex flex-col gap-2">
              {consulta.dados.recibos.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                  <FileText aria-hidden className="size-6" />
                  <span className="flex-1">
                    <strong>Recibo nº {r.numero}</strong> · {formatarDia(r.data, new Date())} · {centavosEmReais(r.valorCentavos)} ({NOME_FORMA_PORTAL[r.forma]})
                    {r.situacao === 'cancelado' && <strong> · cancelado</strong>}
                  </span>
                  <Botao variante="contorno" tamanho="pequeno" onClick={() => imprimir(r.id)}>
                    <Printer aria-hidden />
                    Imprimir
                  </Botao>
                </li>
              ))}
            </ul>
          )}
          {!consulta.dados.documentos.disponivel && (
            <p className="mt-6 text-texto-suave">Atestados, declarações e outros documentos ainda não aparecem no portal. Se precisar, peça à clínica.</p>
          )}
        </>
      )}
      {folha && <FolhaDoRecibo r={folha} />}
    </>
  );
}

function FolhaDoRecibo({ r }: { r: ReciboPortal }) {
  return (
    // Fora do leitor de tela e da tela (R2): só existe para o papel, e só durante a impressão.
    <div data-imprimir aria-hidden="true" className="hidden print:block">
      <h2>
        Recibo nº {r.numero}
        {r.situacao === 'cancelado' ? ' — CANCELADO' : ''}
      </h2>
      <p>
        {r.emitente.nome}
        {r.emitente.documento ? ` · ${r.emitente.tipo === 'pj' ? 'CNPJ' : 'CPF'} ${r.emitente.documento}` : ''}
        {r.emitente.registroConselho ? ` · ${r.emitente.registroConselho}` : ''}
      </p>
      <p>
        Recebi de {r.pagador.nome}
        {r.pagador.cpf ? `, CPF ${r.pagador.cpf}` : ''}, a quantia de {centavosEmReais(r.valorCentavos)}, referente a {r.descricao}
        {r.beneficiario.nome !== r.pagador.nome ? `, prestado a ${r.beneficiario.nome}${r.beneficiario.cpf ? `, CPF ${r.beneficiario.cpf}` : ''}` : ''}, pago em{' '}
        {NOME_FORMA_PORTAL[r.forma]} em {dataBr(r.dataPagamento)}.
      </p>
      {r.situacao === 'cancelado' && <p>Este recibo foi cancelado pela clínica e não vale como comprovante.</p>}
    </div>
  );
}
