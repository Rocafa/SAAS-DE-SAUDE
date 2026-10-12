'use client';

/**
 * Documentos: atestado, declaração de comparecimento e recibo, com prévia e "Imprimir".
 * Sem ICP-Brasil por enquanto (marcado na tela): imprime e assina à mão.
 */
import { FileSignature, Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido } from '@/lib/api/tipos';
import { textoAtestado, textoDeclaracao, validarCid } from '@/lib/prontuario';
import { cn, reais } from '@/lib/utils';

type Tipo = 'atestado' | 'declaracao' | 'recibo';
const TIPOS: { id: Tipo; rotulo: string }[] = [
  { id: 'atestado', rotulo: 'Atestado' },
  { id: 'declaracao', rotulo: 'Declaração de comparecimento' },
  { id: 'recibo', rotulo: 'Recibo' },
];
const REGISTRO: Record<string, string> = { pr1: 'CREFITO-3 000000-F (fictício)', pr2: 'CRP 06/000000 (fictício)', pr3: 'CREFITO-3 000000-TO (fictício)' };
const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';

export default function PaginaDocumentos() {
  return (
    <Suspense fallback={<Carregando />}>
      <Documentos />
    </Suspense>
  );
}

function dataLonga(iso: string) {
  const [a, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(a, m - 1, d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function Documentos() {
  const params = useSearchParams();
  const { usuario } = useDados();
  const pedidoTipo = params.get('tipo');
  const [tipo, setTipo] = useState<Tipo>(TIPOS.some((t) => t.id === pedidoTipo) ? (pedidoTipo as Tipo) : 'atestado');
  const [pacienteId, setPacienteId] = useState(params.get('paciente') ?? '');
  const [profissionalId, setProfissionalId] = useState(usuario?.profissionalId ?? 'pr1');
  const [dias, setDias] = useState('1');
  const [cid, setCid] = useState('');
  const [autorizouCid, setAutorizouCid] = useState(false);
  const [inicio, setInicio] = useState('09:00');
  const [fim, setFim] = useState('10:00');
  const [reciboId, setReciboId] = useState('');
  const hoje = paraIsoLocal(new Date());

  useEffect(() => {
    if (usuario?.profissionalId) setProfissionalId(usuario.profissionalId);
  }, [usuario]);

  const consulta = useConsulta(
    async (a) => {
      const [pacientes, profissionais, recibos] = await Promise.all([a.listarPacientes(), a.listarProfissionais(), a.listarRecibos()]);
      return { pacientes: pacientes.filter((p) => p.ativo).sort((x, y) => nomeExibido(x).localeCompare(nomeExibido(y))), profissionais, recibos };
    },
  );

  const recibosDoPaciente = useMemo(
    () => (consulta.estado === 'pronto' ? consulta.dados.recibos.filter((r) => r.pacienteId === pacienteId) : []),
    [consulta, pacienteId],
  );

  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { pacientes, profissionais } = consulta.dados;
  const paciente = pacientes.find((p) => p.id === pacienteId);
  const prof = profissionais.find((p) => p.id === profissionalId);
  const recibo = recibosDoPaciente.find((r) => r.id === reciboId) ?? recibosDoPaciente[0];
  const nDias = Number(dias);
  const erroDias = tipo === 'atestado' && !(Number.isInteger(nDias) && nDias >= 1 && nDias <= 15) ? 'Afastamento de 1 a 15 dias. Acima disso, siga o fluxo do INSS.' : null;
  const erroCid = tipo === 'atestado' ? validarCid(cid) : null;
  const erroCidSemAutorizacao = tipo === 'atestado' && cid.trim() && !autorizouCid ? 'O CID só entra com a autorização do paciente. Marque a caixa ou apague o CID.' : null;
  const erroHorario = tipo === 'declaracao' && fim <= inicio ? 'O horário de saída tem que ser depois da chegada.' : null;
  const faltaPaciente = !paciente ? 'Falta o paciente. Escolha na lista.' : null;
  const erroRecibo = tipo === 'recibo' && paciente && !recibo ? 'Este paciente ainda não tem pagamento registrado.' : null;
  const erros = [faltaPaciente, erroDias, erroCid, erroCidSemAutorizacao, erroHorario, erroRecibo].filter(Boolean) as string[];

  let corpo = '';
  if (paciente && !erros.length) {
    const nome = nomeExibido(paciente);
    if (tipo === 'atestado')
      corpo = textoAtestado({ paciente: nome, profissional: prof?.nome ?? '', registro: REGISTRO[profissionalId] ?? '', data: dataLonga(hoje), dias: nDias, cid, autorizouCid });
    else if (tipo === 'declaracao') corpo = textoDeclaracao({ paciente: nome, data: dataLonga(hoje), inicio, fim });
    else if (recibo)
      corpo = `Recebi de ${paciente.nome}${paciente.cpf ? `, CPF ${paciente.cpf}` : ''}, a quantia de ${reais(recibo.valor)}, referente a atendimento de ${prof?.especialidade.toLowerCase()} em ${dataLonga(recibo.data)}, pago em ${recibo.forma === 'pix' ? 'Pix' : recibo.forma === 'cartao' ? 'cartão' : 'dinheiro'}.`;
  }

  return (
    <>
      <Titulo descricao="Escolha o documento, confira a prévia e imprima.">Documentos</Titulo>
      <div className="grid gap-8 lg:grid-cols-2">
        <form className="flex flex-col gap-5" onSubmit={(e) => e.preventDefault()}>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-lg font-bold">1. Qual documento</legend>
            {TIPOS.map((t) => (
              <label
                key={t.id}
                className={cn('flex min-h-14 items-center gap-3 rounded-md border-2 px-4 text-lg', tipo === t.id ? 'border-borda-forte font-bold' : 'border-borda')}
              >
                <input type="radio" name="tipo" value={t.id} checked={tipo === t.id} onChange={() => setTipo(t.id)} className="size-6 accent-[var(--texto)]" />
                {t.rotulo}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2">
            <label htmlFor="doc-paciente" className="text-lg font-bold">
              2. Paciente
            </label>
            <select id="doc-paciente" value={pacienteId} onChange={(e) => setPacienteId(e.target.value)} className={CAMPO}>
              <option value="">Escolha o paciente</option>
              {pacientes.map((p) => (
                <option key={p.id} value={p.id}>
                  {nomeExibido(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="doc-prof" className="text-lg font-bold">
              3. Profissional que assina
            </label>
            <select id="doc-prof" value={profissionalId} onChange={(e) => setProfissionalId(e.target.value)} className={CAMPO}>
              {profissionais.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </div>
          {tipo === 'atestado' && (
            <>
              <div className="flex flex-col gap-2">
                <label htmlFor="doc-dias" className="text-lg font-bold">
                  Dias de afastamento
                </label>
                <input id="doc-dias" type="number" inputMode="numeric" min={1} max={15} value={dias} onChange={(e) => setDias(e.target.value)} className={CAMPO} />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="doc-cid" className="text-lg font-bold">
                  CID (opcional)
                </label>
                <p className="text-texto-suave" id="doc-cid-ajuda">
                  Só com autorização do paciente. Sem autorização, deixe em branco.
                </p>
                <input id="doc-cid" value={cid} onChange={(e) => setCid(e.target.value)} aria-describedby="doc-cid-ajuda" className={CAMPO} />
                <label className="flex min-h-12 items-center gap-3 font-bold">
                  <input type="checkbox" checked={autorizouCid} onChange={(e) => setAutorizouCid(e.target.checked)} className="size-6 accent-[var(--texto)]" />
                  O paciente autorizou incluir o CID
                </label>
              </div>
            </>
          )}
          {tipo === 'declaracao' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <label htmlFor="doc-inicio" className="font-bold">
                  Chegou às
                </label>
                <input id="doc-inicio" type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} className={CAMPO} />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="doc-fim" className="font-bold">
                  Saiu às
                </label>
                <input id="doc-fim" type="time" value={fim} onChange={(e) => setFim(e.target.value)} className={CAMPO} />
              </div>
            </div>
          )}
          {tipo === 'recibo' && recibosDoPaciente.length > 0 && (
            <div className="flex flex-col gap-2">
              <label htmlFor="doc-recibo" className="text-lg font-bold">
                Qual pagamento
              </label>
              <select id="doc-recibo" value={recibo?.id ?? ''} onChange={(e) => setReciboId(e.target.value)} className={CAMPO}>
                {recibosDoPaciente.map((r) => (
                  <option key={r.id} value={r.id}>
                    {dataLonga(r.data)} · {reais(r.valor)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {erros.length > 0 && (
            <div role="status" className="rounded-md border-2 border-dashed border-borda p-3 font-bold">
              <ul className="flex flex-col gap-1">
                {erros.map((e) => (
                  <li key={e}>⚠ {e}</li>
                ))}
              </ul>
            </div>
          )}
        </form>

        <section aria-labelledby="t-previa" className="flex flex-col gap-3">
          <h2 id="t-previa" className="text-lg font-bold">
            Prévia
          </h2>
          <div data-imprimir className="flex min-h-96 flex-col gap-6 rounded-md border-2 border-borda-forte bg-white p-8 text-black">
            <p className="text-center font-bold uppercase tracking-wide">Clínica Demonstração</p>
            <h3 className="text-center text-xl font-bold">{TIPOS.find((t) => t.id === tipo)?.rotulo}</h3>
            <p className="flex-1 whitespace-pre-wrap" data-testid="texto-documento">
              {corpo || 'Preencha ao lado para ver o documento.'}
            </p>
            <p>São Paulo, {dataLonga(hoje)}.</p>
            <div className="mt-8 border-t-2 border-black pt-2 text-center">
              <p className="font-bold">{prof?.nome}</p>
              <p>{REGISTRO[profissionalId]}</p>
            </div>
          </div>
          <p className="flex items-start gap-2 rounded-md border-2 border-dashed border-borda p-3">
            <FileSignature aria-hidden className="mt-0.5 size-6 shrink-0" />
            Assinatura digital ICP-Brasil: em breve. Por enquanto, imprima e assine à mão.
          </p>
          <Botao tamanho="grande" disabled={!corpo} onClick={() => window.print()} className="self-start" data-testid="imprimir-documento">
            <Printer aria-hidden />
            Imprimir
          </Botao>
        </section>
      </div>
    </>
  );
}
