'use client';

/**
 * Seções de Configurações. Privacidade e LGPD tem "Baixar todos os dados da clínica" (garantia G2)
 * e "Quem acessou o quê" (auditoria). Plano e assinatura tem "Cancelar" fácil e visível (G4) e
 * explica os 90 dias de leitura e exportação depois do cancelamento (G3).
 */
import { CheckCircle2, Download, KeyRound, Mail, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import type { DadosClinica, Papel, PedidoExportacao } from '@/lib/api/tipos';
import { JANELA_SAIDA_DIAS, avisoDeSaida, validarEmail } from '@/lib/conta';
import { MODELOS } from '@/lib/prontuario';
import { reais } from '@/lib/utils';
import { useConsulta, useDados } from './dados';
import { useAviso } from './desfazer';

const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';

const NOME_PAPEL: Record<Papel, string> = { admin: 'Administrador', profissional: 'Profissional de saúde', recepcao: 'Recepção' };

function Campo({ id, rotulo, children }: { id: string; rotulo: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-bold">
        {rotulo}
      </label>
      {children}
    </div>
  );
}

function SecaoClinica() {
  const { api } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.obterClinica());
  const [d, setD] = useState<DadosClinica | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    if (consulta.estado === 'pronto' && !d) setD(consulta.dados);
  }, [consulta, d]);
  // O erro vem antes: com a primeira carga falhando, `d` fica nulo e a tela ficaria em "Carregando…"
  // para sempre, sem o botão de tentar de novo.
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  if (consulta.estado === 'carregando' || !d) return <Carregando />;
  const mudar = (k: keyof DadosClinica) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  async function salvar(e: FormEvent) {
    e.preventDefault();
    try {
      await api.salvarClinica(d!);
      setErro('');
      avisar({ texto: 'Dados da clínica salvos.' });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu para salvar.');
    }
  }
  return (
    <form onSubmit={salvar} noValidate className="flex max-w-xl flex-col gap-4">
      <Campo id="c-nome" rotulo="Nome da clínica">
        <input id="c-nome" value={d.nome} onChange={mudar('nome')} className={CAMPO} />
      </Campo>
      <Campo id="c-cnpj" rotulo="CNPJ (opcional)">
        <input id="c-cnpj" value={d.cnpj} onChange={mudar('cnpj')} inputMode="numeric" className={CAMPO} />
      </Campo>
      <Campo id="c-tel" rotulo="Telefone">
        <input id="c-tel" value={d.telefone} onChange={mudar('telefone')} type="tel" className={CAMPO} />
      </Campo>
      <Campo id="c-end" rotulo="Endereço">
        <input id="c-end" value={d.endereco} onChange={mudar('endereco')} className={CAMPO} />
      </Campo>
      {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
      <Botao type="submit" className="self-start">
        Salvar
      </Botao>
    </form>
  );
}

// Conteúdo clínico só para perfil clínico com vínculo de cuidado (requisitos §3; veto B1 do Guardião).
const PERMISSOES: [string, string, string, string][] = [
  ['Ver e marcar agenda', 'Sim', 'Sim', 'Sim'],
  ['Cadastrar pacientes', 'Sim', 'Sim', 'Sim'],
  ['Ler prontuário dos pacientes que atende', 'Não', 'Sim', 'Não'],
  ['Assinar o próprio registro', 'Não', 'Sim', 'Não'],
  ['Ler registro de psicologia', 'Não', 'Só o autor', 'Não'],
  ['Emitir atestado', 'Não', 'Sim, em nome próprio', 'Não'],
  ['Receber pagamentos', 'Sim', 'Não', 'Sim'],
  ['Convidar pessoas e mudar permissões', 'Sim', 'Não', 'Não'],
  ['Ver quem acessou o quê', 'Sim', 'Não', 'Não'],
  ['Cancelar ou mudar o plano', 'Sim', 'Não', 'Não'],
  ['Baixar todos os dados da clínica', 'Sim', 'Não', 'Não'],
];

function SoAdmin({ children, oQue }: { children: ReactNode; oQue: string }) {
  const { usuario } = useDados();
  // Falha fechado: enquanto o papel não é conhecido (primeira carga, ou `usuarioAtual` que falhou)
  // nada do conteúdo de administrador aparece.
  if (!usuario) return <Carregando />;
  if (usuario.papel !== 'admin') {
    return <p className="rounded-md border-2 border-dashed border-borda p-3 font-bold">Só o administrador da clínica {oQue}.</p>;
  }
  return <>{children}</>;
}

function SecaoUsuarios() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.listarEquipe());
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<Papel>('recepcao');
  const [erro, setErro] = useState('');
  const [tirando, setTirando] = useState<string | null>(null);

  async function convidar(e: FormEvent) {
    e.preventDefault();
    const ee = validarEmail(email);
    if (ee) return setErro(ee);
    try {
      await api.convidar(email, papel);
      setEmail('');
      setErro('');
      atualizar();
      avisar({ texto: `Convite enviado para ${email.trim()}. O link vale 7 dias.` });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu para convidar.');
    }
  }
  async function tirar(id: string) {
    try {
      const m = await api.removerAcesso(id);
      setTirando(null);
      atualizar();
      if (m)
        avisar({
          texto: `${m.nome} não acessa mais a clínica.`,
          desfazer: async () => {
            await api.devolverAcesso(m);
            atualizar();
          },
        });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu.');
      setTirando(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="t-equipe">
        <h2 id="t-equipe" className="mb-3 text-xl font-bold">
          Equipe
        </h2>
        {consulta.estado === 'carregando' && <Carregando />}
        {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
        {consulta.estado === 'pronto' && (
          <ul className="flex flex-col gap-2">
            {consulta.dados.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex-1">
                    <strong>{m.nome}</strong> · {m.email}
                  </span>
                  <span className="rounded-sm border-2 border-borda px-2 text-[0.9rem]">{NOME_PAPEL[m.papel]}</span>
                  {m.situacao === 'convite_enviado' && (
                    <span className="flex items-center gap-1 rounded-sm border-2 border-dashed border-borda px-2 text-[0.9rem]">
                      <Mail aria-hidden className="size-4" /> Convite enviado
                    </span>
                  )}
                </div>
                {tirando === m.id ? (
                  <div role="alertdialog" aria-label="Confirmar" className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">Tirar o acesso de {m.nome}?</span>
                    <Botao variante="perigo" tamanho="pequeno" onClick={() => tirar(m.id)}>
                      Sim, tirar acesso
                    </Botao>
                    <Botao variante="suave" tamanho="pequeno" onClick={() => setTirando(null)}>
                      Não
                    </Botao>
                  </div>
                ) : (
                  <Botao variante="suave" tamanho="pequeno" className="self-start" onClick={() => setTirando(m.id)}>
                    <Trash2 aria-hidden />
                    Tirar acesso
                  </Botao>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="t-convidar">
        <h2 id="t-convidar" className="mb-3 text-xl font-bold">
          Convidar pessoa
        </h2>
        <form onSubmit={convidar} noValidate className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Campo id="u-email" rotulo="E-mail">
            <input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={CAMPO} />
          </Campo>
          <Campo id="u-papel" rotulo="O que vai fazer">
            <select id="u-papel" value={papel} onChange={(e) => setPapel(e.target.value as Papel)} className={CAMPO}>
              {(Object.keys(NOME_PAPEL) as Papel[]).map((p) => (
                <option key={p} value={p}>
                  {NOME_PAPEL[p]}
                </option>
              ))}
            </select>
          </Campo>
          {erro && (
            <p role="alert" className="font-bold sm:col-span-2">
              ⚠ {erro}
            </p>
          )}
          <Botao type="submit" className="self-start">
            <UserPlus aria-hidden />
            Enviar convite
          </Botao>
        </form>
      </section>
      <section aria-labelledby="t-permissoes">
        <h2 id="t-permissoes" className="mb-3 text-xl font-bold">
          O que cada um pode fazer
        </h2>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Tabela de permissões">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b-2 border-borda-forte">
                <th className="p-2">Pode…</th>
                <th className="p-2">Administrador</th>
                <th className="p-2">Profissional</th>
                <th className="p-2">Recepção</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSOES.map(([o, ...v]) => (
                <tr key={o} className="border-b border-borda">
                  <td className="p-2">{o}</td>
                  {v.map((x, i) => (
                    <td key={i} className={x === 'Não' ? 'p-2' : 'p-2 font-bold'}>
                      {x}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-texto-suave">
          Administrador que também é profissional de saúde segue a coluna “Profissional” para o que é clínico. Registro de
          psicologia: só o psicólogo autor lê (sigilo profissional).
        </p>
      </section>
    </div>
  );
}

const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

function SecaoHorarios() {
  const avisar = useAviso();
  const [dias, setDias] = useState<boolean[]>([true, true, true, true, true, false, false]);
  const [inicio, setInicio] = useState('08:00');
  const [fim, setFim] = useState('18:00');
  const erro = fim <= inicio ? 'O horário de fechar tem que ser depois do de abrir.' : !dias.some(Boolean) ? 'Marque pelo menos um dia.' : '';
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!erro) avisar({ texto: 'Horários salvos.' });
      }}
      className="flex max-w-xl flex-col gap-4"
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-2 font-bold">Dias de atendimento</legend>
        {DIAS.map((d, i) => (
          <label key={d} className="flex min-h-12 items-center gap-3">
            <input type="checkbox" checked={dias[i]} onChange={(e) => setDias((x) => x.map((v, k) => (k === i ? e.target.checked : v)))} className="size-6 accent-[var(--texto)]" />
            {d}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Campo id="h-ini" rotulo="Abre às">
          <input id="h-ini" type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} className={CAMPO} />
        </Campo>
        <Campo id="h-fim" rotulo="Fecha às">
          <input id="h-fim" type="time" value={fim} onChange={(e) => setFim(e.target.value)} className={CAMPO} />
        </Campo>
      </div>
      {erro && <p className="font-bold">⚠ {erro}</p>}
      <p className="text-texto-suave">Cada profissional pode ter horários próprios: isso entra com a API real.</p>
      <Botao type="submit" className="self-start" disabled={!!erro}>
        Salvar horários
      </Botao>
    </form>
  );
}

function SecaoTipos() {
  const consulta = useConsulta((a) => a.listarTiposAtendimento());
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  return (
    <>
      <ul className="flex flex-col gap-2">
        {consulta.dados.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
            <span className="flex-1 font-bold">{t.nome}</span>
            <span>{t.minutos} min</span>
            <span className="font-bold tabular-nums">{reais(t.valor)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-texto-suave">Criar e editar tipos entra com a API real.</p>
    </>
  );
}

function SecaoModelos() {
  return (
    <>
      <ul className="flex flex-col gap-3">
        {Object.values(MODELOS).map((m) => (
          <li key={m.nome} className="rounded-md border-2 border-borda p-3">
            <p className="font-bold">{m.nome}</p>
            <p className="text-texto-suave">{m.campos.map((c) => c.rotulo + (c.obrigatorio ? ' (obrigatório)' : '')).join(' · ')}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-texto-suave">Montar modelo próprio da clínica: em breve.</p>
    </>
  );
}

/**
 * Trilha de acesso. Fica em componente próprio de propósito: assim `listarAuditoria` só é chamada
 * quando quem está na tela é administrador. A trilha traz nome de paciente e e-mail da equipe, então
 * não pode ser buscada para depois ser escondida na renderização.
 */
function TrilhaDeAcesso() {
  const auditoria = useConsulta((a) => a.listarAuditoria());
  const [filtro, setFiltro] = useState('');
  return (
      <section aria-labelledby="t-auditoria">
        <h2 id="t-auditoria" className="mb-2 text-xl font-bold">
          Quem acessou o quê
        </h2>
        <p className="mb-3 text-texto-suave">Tudo fica registrado e não pode ser alterado. Mostramos a ação, nunca o conteúdo do prontuário.</p>
        <label htmlFor="a-filtro" className="font-bold">
          Filtrar por pessoa
        </label>
        <input id="a-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Ex.: Beatriz" className={`${CAMPO} mb-3 mt-2 max-w-md`} />
        {auditoria.estado === 'carregando' && <Carregando />}
        {auditoria.estado === 'erro' && <Erro mensagem={auditoria.mensagem} tentarDeNovo={auditoria.tentarDeNovo} />}
        {auditoria.estado === 'pronto' &&
          (() => {
            const lista = auditoria.dados.filter((e) => e.quem.toLowerCase().includes(filtro.trim().toLowerCase()));
            return lista.length === 0 ? (
              <Vazio titulo="Nada encontrado" oQueFazer="Confira o nome ou apague o filtro." />
            ) : (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Registro de acessos">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b-2 border-borda-forte">
                      <th className="p-2">Quando</th>
                      <th className="p-2">Quem</th>
                      <th className="p-2">O quê</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map((e) => (
                      <tr key={e.id} className="border-b border-borda">
                        <td className="whitespace-nowrap p-2 tabular-nums">
                          {formatarDia(e.quando.slice(0, 10), new Date())} {e.quando.slice(11)}
                        </td>
                        <td className="p-2">{e.quem}</td>
                        <td className="p-2">{e.acao}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
      </section>
  );
}

function SecaoPrivacidade() {
  const { api, usuario, modo } = useDados();
  const [etapa, setEtapa] = useState<'inicio' | 'codigo' | 'pedido'>('inicio');
  const [codigo, setCodigo] = useState('');
  const [ciente, setCiente] = useState(false);
  const [erro, setErro] = useState('');
  const [pedido, setPedido] = useState<PedidoExportacao | null>(null);
  const admin = usuario?.papel === 'admin';

  async function pedir(e: FormEvent) {
    e.preventDefault();
    if (!ciente) return setErro('Marque que você está ciente do sigilo profissional.');
    try {
      setPedido(await api.pedirExportacao(codigo));
      setErro('');
      setEtapa('pedido');
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu para pedir.');
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="t-exportar" className="rounded-md border-[3px] border-borda-forte p-4">
        <h2 id="t-exportar" className="mb-2 flex items-center gap-2 text-xl font-bold">
          <Download aria-hidden className="size-6" />
          Baixar todos os dados da clínica
        </h2>
        <p className="mb-3">
          Grátis e em formato aberto (JSON e planilhas CSV), com tudo da clínica: pacientes, agenda, prontuários e financeiro. Os dados são da
          sua clínica: você pode levar para outro sistema quando quiser.
        </p>
        {!admin ? (
          <p className="font-bold">Só um administrador da clínica pode pedir. Peça ao responsável.</p>
        ) : etapa === 'inicio' ? (
          <Botao tamanho="grande" onClick={() => setEtapa('codigo')}>
            <Download aria-hidden />
            Baixar todos os dados da clínica
          </Botao>
        ) : etapa === 'codigo' ? (
          <form onSubmit={pedir} noValidate className="flex max-w-xl flex-col gap-4">
            <Campo id="x-cod" rotulo="Código do aplicativo autenticador (6 números)">
              <input id="x-cod" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} className={CAMPO} />
            </Campo>
            <p className="text-texto-suave">Na demonstração, use 123456.</p>
            <label className="flex min-h-12 items-start gap-3">
              <input type="checkbox" checked={ciente} onChange={(e) => setCiente(e.target.checked)} className="mt-1 size-6 shrink-0 accent-[var(--texto)]" />
              <span>Estou ciente de que o arquivo tem dados de saúde protegidos por sigilo profissional e vou guardá-lo com segurança.</span>
            </label>
            {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
            <div className="flex flex-wrap gap-2">
              <Botao type="submit">
                <KeyRound aria-hidden />
                Confirmar pedido
              </Botao>
              <Botao variante="suave" onClick={() => setEtapa('inicio')}>
                Voltar
              </Botao>
            </div>
          </form>
        ) : pedido?.status === 'aguardando_rt' ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="font-bold">Pedido feito. Falta a aprovação do responsável técnico da clínica.</p>
            <p>Ele recebe um aviso. Todos os administradores também recebem um e-mail com o botão “Não fui eu”, que cancela o pedido.</p>
            {/*
              Só na demonstração: o dump completo da clínica (pacientes, agenda, prontuários e
              financeiro) exige duas pessoas, e aqui quem aprovaria é quem pediu, no mesmo navegador.
              Com a API real, quem aprova é o responsável técnico, conferido no servidor.
            */}
            {modo === 'fake' && (
              <Botao
                variante="contorno"
                className="self-start"
                onClick={async () => setPedido(await api.aprovarExportacao(pedido.id))}
              >
                <ShieldCheck aria-hidden />
                Aprovar como responsável técnico (demonstração)
              </Botao>
            )}
          </div>
        ) : (
          <p role="status" className="flex items-start gap-2 font-bold">
            <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0" />
            Pronto. O link foi para o seu e-mail: vale até {pedido?.expiraEm ? formatarDia(pedido.expiraEm, new Date()) : 'amanhã'}, só para
            você, e pode ser baixado {pedido?.downloadsRestantes} vezes. O arquivo vai cifrado.
          </p>
        )}
        <p className="mt-3 text-texto-suave">Fluxo de demonstração: a exportação de verdade entra com o login (D4) e a API de exportação.</p>
      </section>

      {admin ? (
        <TrilhaDeAcesso />
      ) : (
        <p className="rounded-md border-2 border-dashed border-borda p-3 font-bold">Só o administrador da clínica vê quem acessou o quê.</p>
      )}
    </div>
  );
}

function SecaoPlano() {
  const { api } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.obterAssinatura());
  const [confirmando, setConfirmando] = useState(false);
  const [atual, setAtual] = useState<Awaited<ReturnType<typeof api.obterAssinatura>> | null>(null);
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const a = atual ?? consulta.dados;

  async function cancelar() {
    const nova = await api.cancelarAssinatura();
    setAtual(nova);
    setConfirmando(false);
    avisar({
      texto: 'Assinatura cancelada. Seus dados ficam disponíveis para ler e baixar.',
      desfazer: async () => setAtual(await api.reativarAssinatura()),
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <section aria-labelledby="t-plano" className="rounded-md border-2 border-borda p-4">
        <h2 id="t-plano" className="text-xl font-bold">
          {a.plano}
        </h2>
        <p className="text-lg">{reais(a.valorMensal)} por mês (valor de exemplo; o preço ainda será decidido) · WhatsApp, IA (dentro da cota) e assinatura na plataforma incluídos</p>
        {a.status === 'ativa' ? (
          <p>Próxima cobrança: {a.proximaCobranca ? formatarDia(a.proximaCobranca, new Date()) : '—'}. Sem fidelidade e sem multa.</p>
        ) : (
          <p className="font-bold" data-testid="situacao-assinatura">
            Cancelada. Até {a.disponivelAte ? formatarDia(a.disponivelAte, new Date()) : '—'} você consulta tudo e baixa os dados da clínica.
            Depois desse prazo, os dados são eliminados com certificado.
          </p>
        )}
      </section>

      {a.status === 'cancelada' && a.canceladaEm && avisoDeSaida(a.canceladaEm, new Date()) && (
        <p role="alert" className="font-bold">
          ⚠ {avisoDeSaida(a.canceladaEm, new Date())}
        </p>
      )}

      {a.status === 'ativa' ? (
        confirmando ? (
          <div role="alertdialog" aria-label="Confirmar cancelamento" className="flex flex-col gap-3 rounded-md border-[3px] border-borda-forte p-4">
            <p className="text-lg font-bold">Cancelar a assinatura?</p>
            <ul className="list-disc pl-6">
              <li>Sem multa e sem ligação.</li>
              <li>Por {JANELA_SAIDA_DIAS} dias você continua lendo tudo e pode baixar os dados da clínica. Avisamos 30, 7 e 1 dia antes do fim.</li>
              <li>A guarda legal do prontuário é da clínica: baixe os dados antes do fim do prazo.</li>
              <li>Depois desse prazo, os dados são eliminados com certificado.</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Botao variante="perigo" onClick={cancelar} data-testid="confirmar-cancelamento">
                Sim, cancelar assinatura
              </Botao>
              <Botao variante="suave" onClick={() => setConfirmando(false)}>
                Não, manter
              </Botao>
            </div>
          </div>
        ) : (
          <Botao variante="contorno" tamanho="grande" onClick={() => setConfirmando(true)} className="self-start">
            Cancelar assinatura
          </Botao>
        )
      ) : (
        <div className="flex flex-wrap gap-2">
          <Botao asChild>
            <Link href="/configuracoes/privacidade">
              <Download aria-hidden />
              Baixar os dados da clínica
            </Link>
          </Botao>
          <Botao variante="contorno" onClick={async () => setAtual(await api.reativarAssinatura())}>
            Voltar a assinar
          </Botao>
        </div>
      )}
    </div>
  );
}

export const SECOES: Record<string, { titulo: string; descricao: string; Componente: () => ReactNode }> = {
  clinica: { titulo: 'Dados da clínica', descricao: 'Nome, endereço e telefone que aparecem nos documentos.', Componente: SecaoClinica },
  usuarios: {
    titulo: 'Usuários e permissões',
    descricao: 'Quem usa o sistema e o que cada um pode fazer.',
    Componente: () => (
      <SoAdmin oQue="convida pessoas e muda permissões">
        <SecaoUsuarios />
      </SoAdmin>
    ),
  },
  horarios: { titulo: 'Horários de atendimento', descricao: 'Dias e horários em que a clínica atende.', Componente: SecaoHorarios },
  tipos: { titulo: 'Tipos de atendimento', descricao: 'Duração e valor de cada tipo de consulta ou sessão.', Componente: SecaoTipos },
  modelos: { titulo: 'Modelos de prontuário', descricao: 'Os campos da evolução de cada especialidade.', Componente: SecaoModelos },
  privacidade: { titulo: 'Privacidade e LGPD', descricao: 'Baixar os dados da clínica e ver quem acessou o quê.', Componente: SecaoPrivacidade },
  plano: {
    titulo: 'Plano e assinatura',
    descricao: 'Seu plano, a próxima cobrança e o cancelamento.',
    Componente: () => (
      <SoAdmin oQue="cancela ou muda o plano">
        <SecaoPlano />
      </SoAdmin>
    ),
  },
};
