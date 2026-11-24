import { CalendarCheck2, History, Paperclip, Receipt, UserPlus, XCircle } from 'lucide-react';
import { Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import type { EventoLinhaTempo } from '@/lib/api/tipos';
import { SeloStatus } from './selo-status';

const TIPO = {
  consulta: { rotulo: 'Consulta', icone: CalendarCheck2 },
  falta: { rotulo: 'Falta', icone: XCircle },
  cancelamento: { rotulo: 'Cancelamento', icone: XCircle },
  recibo: { rotulo: 'Pagamento', icone: Receipt },
  anexo: { rotulo: 'Documento', icone: Paperclip },
  cadastro: { rotulo: 'Cadastro', icone: UserPlus },
} as const;

/** Só metadados do adaptador: nunca abre prontuário nem revela nome de anexo clínico escondido. */
export function LinhaDoTempo({ eventos, agora = new Date() }: { eventos: EventoLinhaTempo[]; agora?: Date }) {
  if (eventos.length === 0) {
    return (
      <Vazio
        titulo="Ainda sem histórico"
        oQueFazer="Consultas, faltas, pagamentos e anexos aparecem aqui, do mais novo para o mais antigo."
      />
    );
  }
  return (
    <ol className="flex flex-col border-l-[3px] border-borda-forte pl-4">
      {eventos.map((evento, indice) => {
        const tipo = TIPO[evento.tipo];
        const Icone = tipo.icone;
        return (
          <li key={`${evento.data}-${evento.hora ?? ''}-${evento.tipo}-${indice}`} className="relative pb-6 last:pb-0">
            <span aria-hidden className="absolute -left-[1.6rem] top-1.5 flex size-4 items-center justify-center rounded-full border-[3px] border-borda-forte bg-fundo" />
            <div className="flex flex-wrap items-center gap-2">
              <History aria-hidden className="size-5" />
              <time className="text-[0.95rem] font-bold" dateTime={`${evento.data}${evento.hora ? `T${evento.hora}` : ''}`}>
                {formatarDia(evento.data, agora)}
                {evento.hora ? ` às ${evento.hora}` : ''}
              </time>
              <SeloStatus texto={tipo.rotulo} aparencia={evento.tipo === 'falta' || evento.tipo === 'cancelamento' ? 'inativo' : 'normal'} />
            </div>
            <p className="mt-2 flex items-center gap-2 text-texto-suave">
              <Icone aria-hidden className="size-5 shrink-0" />
              {evento.texto}
            </p>
            <p className="mt-1 text-[0.95rem] text-texto-suave">{evento.autor ? `Autor: ${evento.autor}` : 'Autor não informado'}</p>
          </li>
        );
      })}
    </ol>
  );
}
