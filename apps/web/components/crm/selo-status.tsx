import { Circle, XCircle } from 'lucide-react';
import { Status } from '@/components/ui/estados';
import type { StatusAgendamento } from '@/lib/api/tipos';
import { cn } from '@/lib/utils';

type SeloStatusProps =
  | { status: StatusAgendamento; texto?: never; aparencia?: never }
  | { texto: string; status?: never; aparencia?: 'normal' | 'destaque' | 'inativo' };

/** Selo sempre tem texto e ícone. Status de agenda usa o componente já existente, sem duplicar regras. */
export function SeloStatus(props: SeloStatusProps) {
  if (props.status) return <Status status={props.status} />;
  const inativo = props.aparencia === 'inativo';
  const Icone = inativo ? XCircle : Circle;
  return (
    <span
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-sm border-2 border-borda px-2 text-[0.9rem]',
        props.aparencia === 'destaque' && 'border-borda-forte font-bold',
        inativo && 'border-dashed line-through',
      )}
    >
      <Icone aria-hidden className="size-5" />
      {props.texto}
    </span>
  );
}
