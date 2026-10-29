'use client';

/**
 * Prontuário do paciente: registros assinados do mais novo para o mais antigo. Psicologia em
 * compartimento separado e marcado; quem não é o autor vê só que o registro existe.
 */
import { ArrowLeft, FileText, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useConsulta, useDados } from '@/components/app/dados';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import { nomeExibido, type Profissional, type Registro } from '@/lib/api/tipos';
import { MODELOS, ehPerfilClinico } from '@/lib/prontuario';
import { indexarPorId } from '@/lib/indexar';

const MOTIVO: Record<NonNullable<Registro['motivoOculto']>, string> = {
  perfil_nao_clinico: 'Conteúdo clínico: só os profissionais que atendem o paciente leem.',
  sem_vinculo: 'Conteúdo restrito: você não atende este paciente.',
  sigilo_psicologia: 'Conteúdo restrito ao profissional autor (sigilo profissional).',
};

function Lista({ registros, profissionais }: { registros: Registro[]; profissionais: Map<string, Profissional> }) {
  return (
    <ol className="flex flex-col gap-3">
      {registros.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 rounded-md border-2 border-borda p-4">
          <p className="font-bold">
            {formatarDia(r.data, new Date())} · {profissionais.get(r.profissionalId)?.nome} ·{' '}
            {r.status === 'assinado' ? 'assinado' : 'rascunho (não assinado)'}
          </p>
          {r.conteudoOculto ? (
            <p className="flex items-center gap-2">
              <Lock aria-hidden className="size-5" />
              {MOTIVO[r.motivoOculto ?? 'perfil_nao_clinico']}
            </p>
          ) : (
            <dl className="flex flex-col gap-2">
              {MODELOS[r.modelo].campos
                .filter((c) => r.campos[c.id])
                .map((c) => (
                  <div key={c.id}>
                    <dt className="text-[0.95rem] font-bold text-texto-suave">{c.rotulo}</dt>
                    <dd className="whitespace-pre-wrap">{r.campos[c.id]}</dd>
                  </div>
                ))}
            </dl>
          )}
          {r.adendos.map((a, i) => (
            <p key={i} className="rounded-md border-2 border-dashed border-borda p-2">
              <strong>Adendo de {formatarDia(a.em, new Date())}:</strong> {a.texto}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}

export default function PaginaProntuario() {
  const { id } = useParams<{ id: string }>();
  const { usuario } = useDados();
  const clinico = ehPerfilClinico(usuario);
  const consulta = useConsulta(
    async (a) => {
      const [paciente, registros, profissionais] = await Promise.all([a.obterPaciente(id), a.listarRegistros(id), a.listarProfissionais()]);
      return { paciente, registros, profissionais: indexarPorId(profissionais) };
    },
    [id],
  );
  if (consulta.estado === 'carregando') return <Carregando texto="Abrindo o prontuário…" />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { paciente, registros, profissionais } = consulta.dados;
  if (!paciente) return <Vazio titulo="Paciente não encontrado" oQueFazer="Volte para a lista de Pacientes." />;
  const comuns = registros.filter((r) => !r.restrito);
  const sigilosos = registros.filter((r) => r.restrito);

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Botao asChild variante="suave" tamanho="pequeno" className="self-start">
          <Link href={`/pacientes/${paciente.id}`}>
            <ArrowLeft aria-hidden />
            Voltar para a ficha
          </Link>
        </Botao>
        <p className="text-[0.95rem] font-bold uppercase tracking-wide text-texto-suave">Prontuário · fictício</p>
        <h1 className="text-[2rem] font-bold leading-tight">{nomeExibido(paciente)}</h1>
        {!clinico && (
          <p role="status" className="flex items-start gap-2 rounded-md border-[3px] border-borda-forte p-3 font-bold">
            <Lock aria-hidden className="mt-0.5 size-6 shrink-0" />
            Seu perfil não tem acesso ao conteúdo clínico. Aqui aparecem só a data e o profissional de cada registro.
          </p>
        )}
      </header>

      <section aria-labelledby="t-comuns">
        <h2 id="t-comuns" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <FileText aria-hidden className="size-6" />
          Evoluções
        </h2>
        {comuns.length === 0 ? <Vazio titulo="Nenhuma evolução ainda" oQueFazer="As evoluções assinadas aparecem aqui." /> : <Lista registros={comuns} profissionais={profissionais} />}
      </section>

      {sigilosos.length > 0 && (
        <section aria-labelledby="t-sigilo" className="rounded-md border-[3px] border-double border-borda-forte p-4">
          <h2 id="t-sigilo" className="mb-1 flex items-center gap-2 text-xl font-bold">
            <Lock aria-hidden className="size-6" />
            Psicologia — compartimento sigiloso
          </h2>
          <p className="mb-3 text-texto-suave">Separado das demais evoluções. Só o psicólogo autor lê o conteúdo.</p>
          <Lista registros={sigilosos} profissionais={profissionais} />
        </section>
      )}
    </article>
  );
}
