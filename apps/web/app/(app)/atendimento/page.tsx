'use client';

/** Atendimento: quem atender agora (do profissional que está usando) e o que falta assinar. */
import { PenLine, Stethoscope } from 'lucide-react';
import Link from 'next/link';
import { useConsulta, useDados } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido } from '@/lib/api/tipos';

export default function PaginaAtendimento() {
  const { usuario } = useDados();
  const hoje = paraIsoLocal(new Date());
  const profId = usuario?.profissionalId;
  const consulta = useConsulta(
    async (a) => {
      const [ags, pacientes, profissionais] = await Promise.all([
        a.listarAgendamentos({ de: hoje, ate: hoje, ...(profId ? { profissionalId: profId } : {}) }),
        a.listarPacientes(),
        a.listarProfissionais(),
      ]);
      const registros = await Promise.all(ags.map((g) => a.obterRegistroDoAgendamento(g.id)));
      return {
        itens: ags
          .filter((g) => g.status !== 'cancelado' && g.status !== 'faltou')
          .map((g) => ({ g, registro: registros[ags.indexOf(g)] ?? null })),
        pacientes: new Map(pacientes.map((p) => [p.id, p])),
        profissionais: new Map(profissionais.map((p) => [p.id, p])),
      };
    },
    [hoje, profId],
  );

  return (
    <>
      <Titulo
        descricao={
          profId
            ? 'Seus atendimentos de hoje. Aperte em “Atender” para escrever a evolução.'
            : 'Atendimentos de hoje de todos os profissionais. Só o profissional do atendimento escreve e assina a evolução.'
        }
      >
        Atendimento
      </Titulo>
      {!profId && (
        <p className="mb-6 rounded-md border-2 border-dashed border-borda p-3">
          Você entrou como <strong>{usuario?.nome}</strong>. Para ver como o profissional usa, troque em{' '}
          <Link href="/mais">Mais opções › Demonstração</Link>.
        </p>
      )}
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (consulta.dados.itens.length === 0 ? (
          <Vazio titulo="Nenhum atendimento hoje" oQueFazer="Quando houver consulta marcada para hoje, ela aparece aqui." />
        ) : (
          <ul className="flex flex-col gap-2">
            {consulta.dados.itens.map(({ g, registro }) => {
              const p = consulta.dados.pacientes.get(g.pacienteId);
              const assinado = registro?.status === 'assinado';
              return (
                <li key={g.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                  <span className="w-16 text-lg font-bold tabular-nums">{g.hora}</span>
                  <span className="flex min-w-40 flex-1 flex-col">
                    <span className="text-lg font-bold">{p ? nomeExibido(p) : 'Paciente'}</span>
                    <span className="text-[0.95rem] text-texto-suave">{consulta.dados.profissionais.get(g.profissionalId)?.nome}</span>
                  </span>
                  <Status status={g.status} />
                  {registro && !assinado && <span className="rounded-sm border-2 border-dashed border-borda px-2 text-[0.9rem] font-bold">Rascunho</span>}
                  {profId === g.profissionalId && (
                    <Botao asChild variante={assinado ? 'contorno' : 'principal'} tamanho="pequeno">
                      <Link href={`/atendimento/${g.id}`}>
                        {assinado ? <PenLine aria-hidden /> : <Stethoscope aria-hidden />}
                        {assinado ? 'Ver evolução' : registro ? 'Continuar' : 'Atender'}
                      </Link>
                    </Botao>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </>
  );
}
