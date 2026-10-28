'use client';

/** Todos os recibos, do mais novo para o mais antigo, com "Imprimir" (abre em Documentos). */
import { Printer } from 'lucide-react';
import Link from 'next/link';
import { useConsulta } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import { nomeExibido } from '@/lib/api/tipos';
import { NOME_FORMA } from '@/lib/financeiro';
import { reais } from '@/lib/utils';

export default function PaginaRecibos() {
  const consulta = useConsulta(async (a) => {
    const [recibos, pacientes] = await Promise.all([a.listarRecibos(), a.listarPacientes()]);
    return { recibos: recibos.slice(0, 50), pacientes: new Map(pacientes.map((p) => [p.id, p])) };
  });
  return (
    <>
      <Titulo descricao="Os 50 mais recentes. Para achar um mais antigo, use o Ajudante: “recibo da Maria”.">Recibos</Titulo>
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (consulta.dados.recibos.length === 0 ? (
          <Vazio titulo="Nenhum recibo ainda" oQueFazer="Os recibos aparecem quando você registra um pagamento em Financeiro." />
        ) : (
          <ul className="flex flex-col gap-2">
            {consulta.dados.recibos.map((r) => {
              const p = consulta.dados.pacientes.get(r.pacienteId);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                  <span className="flex-1">
                    <strong>{p ? nomeExibido(p) : 'Paciente'}</strong> · {formatarDia(r.data, new Date())} · {NOME_FORMA[r.forma]}
                  </span>
                  <span className="font-bold tabular-nums">{reais(r.valor)}</span>
                  <Botao asChild variante="contorno" tamanho="pequeno">
                    <Link href={`/documentos?tipo=recibo&paciente=${r.pacienteId}`}>
                      <Printer aria-hidden />
                      Imprimir
                    </Link>
                  </Botao>
                </li>
              );
            })}
          </ul>
        ))}
    </>
  );
}
