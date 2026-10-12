'use client';

/**
 * Tela de atendimento: evolução pelo modelo do nicho, rascunho salvo sozinho, histórico e "Assinar".
 * Psicologia fica em compartimento separado e marcado. Escriba de IA: só aviso, DESLIGADO
 * (veto do Guardião até cumprir as condições; Res. CFM 2.454/2026 exige revisão humana).
 */
import { CheckCircle2, FilePlus2, Lock, Mic, PenLine, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import { nomeExibido, type Registro } from '@/lib/api/tipos';
import { MODELOS, faltasParaAssinar, modeloDoProfissional } from '@/lib/prontuario';

const CAMPO = 'w-full rounded-md border-2 border-borda-forte bg-fundo p-3 text-lg';

export default function PaginaAtender() {
  const { id } = useParams<{ id: string }>();
  const { api, usuario, atualizar } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta(
    async (a) => {
      const ag = (await a.listarAgendamentos()).find((x) => x.id === id) ?? null;
      if (!ag) return null;
      const [paciente, profissionais, registro, historico] = await Promise.all([
        a.obterPaciente(ag.pacienteId),
        a.listarProfissionais(),
        a.obterRegistroDoAgendamento(id),
        a.listarRegistros(ag.pacienteId),
      ]);
      return { ag, paciente, profissional: profissionais.find((p) => p.id === ag.profissionalId), registro, historico: historico.filter((r) => r.agendamentoId !== id) };
    },
    [id],
  );

  const [campos, setCampos] = useState<Record<string, string>>({});
  const [registro, setRegistro] = useState<Registro | null>(null);
  const [salvoAs, setSalvoAs] = useState('');
  const [erro, setErro] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [adendo, setAdendo] = useState('');
  const carregado = useRef(false);
  const mudou = useRef(false);

  useEffect(() => {
    if (consulta.estado !== 'pronto' || !consulta.dados || carregado.current) return;
    carregado.current = true;
    setRegistro(consulta.dados.registro);
    setCampos(consulta.dados.registro?.campos ?? {});
  }, [consulta]);

  // Rascunho salvo sozinho 1 segundo depois da última tecla.
  useEffect(() => {
    if (!mudou.current || registro?.status === 'assinado') return;
    const t = setTimeout(async () => {
      try {
        const r = await api.salvarRascunho(id, campos);
        setRegistro(r);
        setSalvoAs(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
        setErro('');
      } catch (e) {
        setErro(e instanceof Error ? e.message : 'Não deu para salvar o rascunho.');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [campos, api, id, registro?.status]);

  if (consulta.estado === 'carregando') return <Carregando texto="Abrindo o atendimento…" />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  if (!consulta.dados || !consulta.dados.paciente) {
    return (
      <Vazio
        titulo="Atendimento não encontrado"
        oQueFazer="Volte para Atendimento e escolha de novo."
        acao={
          <Botao asChild variante="contorno">
            <Link href="/atendimento">Ir para Atendimento</Link>
          </Botao>
        }
      />
    );
  }
  const { ag, paciente, profissional, historico } = consulta.dados;
  const modelo = modeloDoProfissional(profissional);
  const def = MODELOS[modelo];
  const autor = usuario?.profissionalId === ag.profissionalId;
  const assinado = registro?.status === 'assinado';
  const nome = nomeExibido(paciente);

  async function assinar() {
    const faltas = faltasParaAssinar(modelo, campos);
    if (faltas.length) {
      setErro(faltas.join(' '));
      setConfirmando(false);
      return;
    }
    try {
      const r = registro ? registro : await api.salvarRascunho(id, campos);
      await api.salvarRascunho(id, campos);
      const assinadoR = await api.assinarRegistro(r.id);
      setRegistro(assinadoR);
      setConfirmando(false);
      setErro('');
      atualizar();
      avisar({ texto: `Evolução de ${nome} assinada.` });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não deu para assinar.');
      setConfirmando(false);
    }
  }

  async function salvarAdendo() {
    if (!registro) return;
    try {
      const r = await api.adicionarAdendo(registro.id, adendo);
      setRegistro({ ...r });
      setAdendo('');
      avisar({ texto: 'Adendo adicionado ao registro.' });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não deu para salvar o adendo.');
    }
  }

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-[0.95rem] font-bold uppercase tracking-wide text-texto-suave">
          Atendimento · {formatarDia(ag.data, new Date())} às {ag.hora}
        </p>
        <h1 className="text-[2rem] font-bold leading-tight">{nome}</h1>
        <p className="text-texto-suave">
          {profissional?.nome} · {def.nome} ·{' '}
          <Link href={`/pacientes/${paciente.id}/prontuario`}>Ver prontuário completo</Link>
        </p>
      </header>

      {modelo === 'psicologia' && (
        <p className="flex items-start gap-3 rounded-md border-[3px] border-double border-borda-forte p-3">
          <Lock aria-hidden className="mt-0.5 size-6 shrink-0" />
          <span>
            <strong>Registro psicológico — compartimento sigiloso.</strong> Só você lê. Não aparece para a recepção nem para outros
            profissionais, e sai marcado na exportação dos dados.
          </span>
        </p>
      )}

      {!autor ? (
        <Vazio titulo="Só o profissional do atendimento escreve aqui" oQueFazer={`Este atendimento é de ${profissional?.nome}. Troque de usuário em Mais opções › Demonstração para ver como ele usa.`} />
      ) : assinado ? (
        <section aria-labelledby="t-assinado" className="flex flex-col gap-4">
          <h2 id="t-assinado" className="flex items-center gap-2 text-xl font-bold">
            <CheckCircle2 aria-hidden className="size-6" />
            Assinado {registro?.assinadoEm ? formatarDia(registro.assinadoEm, new Date()) : ''}
          </h2>
          <dl className="flex flex-col gap-3">
            {def.campos.map((c) => (
              <div key={c.id}>
                <dt className="font-bold">{c.rotulo}</dt>
                <dd className="whitespace-pre-wrap">{registro?.campos[c.id] || '—'}</dd>
              </div>
            ))}
          </dl>
          {registro?.adendos.map((a, i) => (
            <p key={i} className="rounded-md border-2 border-dashed border-borda p-3">
              <strong>Adendo de {formatarDia(a.em, new Date())}:</strong> {a.texto}
            </p>
          ))}
          <div className="flex flex-col gap-2">
            <label htmlFor="adendo" className="font-bold">
              Corrigir ou acrescentar (vira adendo, o original não muda)
            </label>
            <textarea id="adendo" rows={3} value={adendo} onChange={(e) => setAdendo(e.target.value)} className={CAMPO} />
            <Botao variante="contorno" onClick={salvarAdendo} className="self-start">
              <FilePlus2 aria-hidden />
              Adicionar adendo
            </Botao>
          </div>
        </section>
      ) : (
        <section aria-labelledby="t-evolucao" className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="t-evolucao" className="text-xl font-bold">
              {def.nome}
            </h2>
            <p role="status" aria-live="polite" className="text-[0.95rem] text-texto-suave">
              {salvoAs ? `Rascunho salvo às ${salvoAs}` : 'O rascunho é salvo sozinho enquanto você escreve.'}
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-md border-2 border-dashed border-borda p-3">
            <Botao variante="suave" disabled className="self-start">
              <Mic aria-hidden />
              Escriba de IA (em breve)
            </Botao>
            <p className="text-texto-suave">
              Em breve: a IA escreve um rascunho a partir da consulta e <strong>você revisa antes de assinar</strong>. Fica
              desligado até cumprir as regras de privacidade e o consentimento do paciente.
            </p>
          </div>

          {def.campos.map((c) => (
            <div key={c.id} className="flex flex-col gap-2">
              <label htmlFor={`c-${c.id}`} className="text-lg font-bold">
                {c.rotulo}
                {c.obrigatorio ? '' : ' (opcional)'}
              </label>
              <p id={`a-${c.id}`} className="text-texto-suave">
                {c.ajuda}
              </p>
              {c.tipo === 'escala' ? (
                <select
                  id={`c-${c.id}`}
                  aria-describedby={`a-${c.id}`}
                  value={campos[c.id] ?? ''}
                  onChange={(e) => {
                    mudou.current = true;
                    setErro('');
                    setCampos((x) => ({ ...x, [c.id]: e.target.value }));
                  }}
                  className={`${CAMPO} min-h-14`}
                >
                  <option value="">Não avaliado</option>
                  {Array.from({ length: 11 }, (_, n) => (
                    <option key={n} value={String(n)}>
                      {n}
                      {n === 0 ? ' — sem dor' : n === 10 ? ' — pior dor' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <textarea
                  id={`c-${c.id}`}
                  aria-describedby={`a-${c.id}`}
                  rows={3}
                  value={campos[c.id] ?? ''}
                  onChange={(e) => {
                    mudou.current = true;
                    setErro('');
                    setCampos((x) => ({ ...x, [c.id]: e.target.value }));
                  }}
                  className={CAMPO}
                />
              )}
            </div>
          ))}

          {erro && (
            <p role="alert" className="rounded-md border-[3px] border-borda-forte p-3 font-bold">
              ⚠ {erro}
            </p>
          )}

          {confirmando ? (
            <div role="alertdialog" aria-label="Confirmar assinatura" className="flex flex-col gap-3 rounded-md border-[3px] border-borda-forte p-4">
              <p className="font-bold">Assinar a evolução de {nome}?</p>
              <p>Depois de assinada ela não muda mais. Se precisar corrigir, você adiciona um adendo.</p>
              <p className="text-texto-suave">Assinatura eletrônica da plataforma. A assinatura com certificado ICP-Brasil entra depois.</p>
              <div className="flex flex-wrap gap-2">
                <Botao onClick={assinar} autoFocus data-testid="confirmar-assinatura">
                  <ShieldCheck aria-hidden />
                  Sim, assinar
                </Botao>
                <Botao variante="suave" onClick={() => setConfirmando(false)}>
                  Voltar e revisar
                </Botao>
              </div>
            </div>
          ) : (
            <Botao tamanho="grande" onClick={() => setConfirmando(true)} className="self-start">
              <PenLine aria-hidden />
              Assinar
            </Botao>
          )}
        </section>
      )}

      <section aria-labelledby="t-historico">
        <h2 id="t-historico" className="mb-3 text-xl font-bold">
          Histórico
        </h2>
        {historico.length === 0 ? (
          <Vazio titulo="Primeiro atendimento" oQueFazer="Os registros anteriores aparecem aqui." />
        ) : (
          <ul className="flex flex-col gap-2">
            {historico.map((r) => (
              <li key={r.id} className="rounded-md border-2 border-borda p-3">
                <p className="font-bold">
                  {formatarDia(r.data, new Date())} · {MODELOS[r.modelo].nome}
                  {r.restrito ? ' · sigiloso' : ''}
                </p>
                {Object.keys(r.campos).length === 0 ? (
                  <p className="flex items-center gap-2 text-texto-suave">
                    <Lock aria-hidden className="size-5" />
                    Conteúdo restrito ao profissional autor.
                  </p>
                ) : (
                  <p className="text-texto-suave">
                    {MODELOS[r.modelo].campos
                      .map((c) => r.campos[c.id])
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
