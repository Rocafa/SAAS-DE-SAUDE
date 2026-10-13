'use client';

/**
 * Primeiros passos: configurar a clínica em 5 passos. Dá para pular e voltar depois.
 * Trazer dados do sistema antigo: com simulação antes e "desfazer" (garantia G8), chega com a API.
 */
import { ArrowLeft, ArrowRight, Check, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { PASSOS_PRIMEIRO_USO } from '@/lib/conta';

const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';
const NICHOS = ['Fisioterapia', 'Terapia ocupacional', 'Psicologia', 'Fonoaudiologia', 'Nutrição', 'Outra'];

export default function PaginaPrimeirosPassos() {
  const router = useRouter();
  const avisar = useAviso();
  const [i, setI] = useState(0);
  const [nome, setNome] = useState('');
  const [nicho, setNicho] = useState('Fisioterapia');
  const [profs, setProfs] = useState(['']);
  const [inicio, setInicio] = useState('08:00');
  const [fim, setFim] = useState('18:00');
  const [tipos, setTipos] = useState([{ nome: 'Sessão', minutos: '50', valor: '150' }]);
  const [erro, setErro] = useState('');
  const passo = PASSOS_PRIMEIRO_USO[i]!;
  const ultimo = i === PASSOS_PRIMEIRO_USO.length - 1;

  function continuar() {
    if (passo.id === 'clinica' && !nome.trim()) return setErro('Falta o nome da clínica. Pode ser o nome que está na fachada.');
    if (passo.id === 'horarios' && fim <= inicio) return setErro('O horário de fechar tem que ser depois do de abrir.');
    setErro('');
    if (ultimo) {
      avisar({ texto: 'Tudo pronto. Bom trabalho!' });
      router.push('/inicio');
    } else setI(i + 1);
  }

  return (
    <>
      <Titulo descricao="Leva uns 5 minutos. Dá para pular e completar depois em Configurações.">Primeiros passos</Titulo>
      <ol aria-label="Passos" className="mb-6 flex flex-wrap gap-2">
        {PASSOS_PRIMEIRO_USO.map((p, k) => (
          <li
            key={p.id}
            aria-current={k === i ? 'step' : undefined}
            className={`flex min-h-12 items-center gap-2 rounded-md border-2 px-3 ${k === i ? 'border-borda-forte font-bold' : k < i ? 'border-borda' : 'border-dashed border-borda'}`}
          >
            {k < i ? <Check aria-hidden className="size-5" /> : <span aria-hidden>{k + 1}.</span>}
            {p.titulo}
            {k < i && <span className="sr-only"> (feito)</span>}
          </li>
        ))}
      </ol>
      <section aria-labelledby="t-passo" className="flex max-w-xl flex-col gap-4">
        <h2 id="t-passo" className="text-xl font-bold">
          Passo {i + 1} de {PASSOS_PRIMEIRO_USO.length}: {passo.titulo}
        </h2>
        {passo.id === 'clinica' && (
          <>
            <label htmlFor="pp-nome" className="font-bold">
              Nome da clínica
            </label>
            <input id="pp-nome" value={nome} onChange={(e) => setNome(e.target.value)} className={CAMPO} />
            <label htmlFor="pp-nicho" className="font-bold">
              Especialidade principal
            </label>
            <select id="pp-nicho" value={nicho} onChange={(e) => setNicho(e.target.value)} className={CAMPO}>
              {NICHOS.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <p className="text-texto-suave">Usamos a especialidade para já trazer o modelo de prontuário certo.</p>
          </>
        )}
        {passo.id === 'profissionais' && (
          <>
            {profs.map((p, k) => (
              <div key={k} className="flex flex-col gap-2">
                <label htmlFor={`pp-prof-${k}`} className="font-bold">
                  Nome do profissional {k + 1}
                </label>
                <input id={`pp-prof-${k}`} value={p} onChange={(e) => setProfs((x) => x.map((v, j) => (j === k ? e.target.value : v)))} className={CAMPO} />
              </div>
            ))}
            <Botao variante="contorno" className="self-start" onClick={() => setProfs((x) => [...x, ''])}>
              Mais um profissional
            </Botao>
            <p className="text-texto-suave">Depois você manda o convite por e-mail em Configurações › Usuários.</p>
          </>
        )}
        {passo.id === 'horarios' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="pp-ini" className="font-bold">
                Abre às
              </label>
              <input id="pp-ini" type="time" value={inicio} onChange={(e) => setInicio(e.target.value)} className={CAMPO} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="pp-fim" className="font-bold">
                Fecha às
              </label>
              <input id="pp-fim" type="time" value={fim} onChange={(e) => setFim(e.target.value)} className={CAMPO} />
            </div>
          </div>
        )}
        {passo.id === 'tipos' &&
          tipos.map((t, k) => (
            <fieldset key={k} className="grid gap-3 rounded-md border-2 border-borda p-3 sm:grid-cols-3">
              <legend className="px-1 font-bold">Tipo {k + 1}</legend>
              {(['nome', 'minutos', 'valor'] as const).map((c) => (
                <div key={c} className="flex flex-col gap-1">
                  <label htmlFor={`pp-t-${k}-${c}`}>{c === 'nome' ? 'Nome' : c === 'minutos' ? 'Minutos' : 'Valor (R$)'}</label>
                  <input
                    id={`pp-t-${k}-${c}`}
                    value={t[c]}
                    inputMode={c === 'nome' ? undefined : 'numeric'}
                    onChange={(e) => setTipos((x) => x.map((v, j) => (j === k ? { ...v, [c]: e.target.value } : v)))}
                    className={CAMPO}
                  />
                </div>
              ))}
            </fieldset>
          ))}
        {passo.id === 'importar' && (
          <>
            <p>
              Vindo de outro sistema? A nossa equipe ajuda a trazer pacientes, agenda e prontuários. Antes de gravar, mostramos uma{' '}
              <strong>simulação</strong> para você conferir, e dá para <strong>desfazer</strong>.
            </p>
            <Botao variante="contorno" disabled className="self-start">
              <Upload aria-hidden />
              Enviar arquivo do sistema antigo (em breve)
            </Botao>
          </>
        )}
        {erro && (
          <p role="alert" className="font-bold">
            ⚠ {erro}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          {i > 0 && (
            <Botao variante="suave" onClick={() => setI(i - 1)}>
              <ArrowLeft aria-hidden />
              Voltar
            </Botao>
          )}
          <Botao onClick={continuar} data-testid="continuar-passo">
            {ultimo ? 'Concluir' : 'Continuar'}
            <ArrowRight aria-hidden />
          </Botao>
          {!ultimo && (
            <Botao variante="suave" onClick={() => router.push('/inicio')}>
              Pular por agora
            </Botao>
          )}
        </div>
      </section>
    </>
  );
}
