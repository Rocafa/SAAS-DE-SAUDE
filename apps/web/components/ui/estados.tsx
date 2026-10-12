'use client';

/**
 * Estados obrigatórios de toda tela: carregando, vazio (com o que fazer), erro (com "Tentar de novo")
 * e sem internet. Diferenciados por ícone, borda e texto, nunca por cor.
 */
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, DoorOpen, Inbox, Loader2, RotateCcw, WifiOff, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { NOME_STATUS, type StatusAgendamento } from '@/lib/api/tipos';
import { Botao } from './botao';

export function Carregando({ texto = 'Carregando…' }: { texto?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border-2 border-borda p-5">
      <Loader2 aria-hidden className="size-6 animate-spin" />
      <span>{texto}</span>
    </div>
  );
}

export function Vazio({ titulo, oQueFazer, acao }: { titulo: string; oQueFazer: string; acao?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border-2 border-dashed border-borda p-5">
      <p className="flex items-center gap-3 text-lg font-bold">
        <Inbox aria-hidden className="size-6" />
        {titulo}
      </p>
      <p className="text-texto-suave">{oQueFazer}</p>
      {acao}
    </div>
  );
}

export function Erro({ mensagem, tentarDeNovo }: { mensagem: string; tentarDeNovo: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border-[3px] border-borda-forte p-5">
      <p className="flex items-center gap-3 text-lg font-bold">
        <AlertTriangle aria-hidden className="size-6" />
        Não deu certo
      </p>
      <p>{mensagem} Confira a internet e tente de novo. Se continuar, chame o suporte no chat.</p>
      <Botao variante="contorno" onClick={tentarDeNovo}>
        <RotateCcw aria-hidden />
        Tentar de novo
      </Botao>
    </div>
  );
}

export function SemInternet() {
  return (
    <div role="status" className="flex items-center gap-3 border-b-[3px] border-borda-forte bg-superficie-2 px-4 py-3 font-bold">
      <WifiOff aria-hidden className="size-6 shrink-0" />
      <span>Sem internet. Confira o Wi-Fi ou os dados do celular. Tentamos de novo sozinhos quando a conexão voltar.</span>
    </div>
  );
}

/** Status do agendamento: muda por ícone, borda e peso, nunca por cor. */
const ICONE_STATUS: Record<StatusAgendamento, typeof Circle> = {
  agendado: CircleDashed,
  confirmado: Circle,
  chegou: DoorOpen,
  em_atendimento: Clock,
  atendido: CheckCircle2,
  faltou: XCircle,
  cancelado: XCircle,
};

export function Status({ status }: { status: StatusAgendamento }) {
  const Icone = ICONE_STATUS[status];
  const forte = status === 'chegou' || status === 'em_atendimento';
  return (
    <span
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-sm border-2 px-2 text-[0.9rem] ${
        forte ? 'border-borda-forte font-bold' : status === 'agendado' ? 'border-dashed border-borda' : 'border-borda'
      } ${status === 'cancelado' || status === 'faltou' ? 'line-through' : ''}`}
    >
      <Icone aria-hidden className="size-5" />
      {NOME_STATUS[status]}
    </span>
  );
}

