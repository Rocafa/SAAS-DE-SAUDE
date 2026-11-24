/** Fixtures FICTÍCIOS de filas, jobs e eventos. Não são registrados nem executados. */
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { Worker } from 'bullmq';
import type { TenantTx } from '../../../src/db/tenant-transaction';
import { recordAudit } from '../../../src/modules/audit/audit-log';

declare const tx: TenantTx;
declare const ctx: RequestContext;

async function semTrilha(): Promise<void> {
  await Promise.resolve();
}

async function comTrilha(): Promise<void> {
  await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'ficticio' });
}

export const filaSemTrilha = new Worker('fila-ficticia-sem-trilha', semTrilha);
export const filaComTrilha = new Worker('fila-ficticia-com-trilha', comTrilha);

/** Substitui o decorator de biblioteca no fixture: a análise resolve o símbolo, não depende do pacote instalado. */
function OnEvent(evento: string): MethodDecorator {
  return () => void evento;
}

export class EventosFicticios {
  @OnEvent('ficticio.sem-trilha')
  async semTrilha(): Promise<void> {
    await Promise.resolve();
  }

  @OnEvent('ficticio.com-trilha')
  async comTrilha(): Promise<void> {
    await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'ficticio' });
  }
}

function Processor(fila: string): ClassDecorator {
  return () => void fila;
}

@Processor('fila-ficticia-worker-host')
export class ProcessadorFicticio {
  async process(): Promise<void> {
    await Promise.resolve();
  }
}

export const temporizador = setInterval(() => void semTrilha(), 60_000);
const agendar = setInterval;
export const temporizadorPorApelido = agendar(() => void comTrilha(), 60_000);

export function criarRegistroDeJobs() {
  return [
    { nome: 'job-ficticio', trilha: 'sempre' as const, porClinica: semTrilha },
    {
      nome: 'job-metodo-ficticio',
      trilha: 'sempre' as const,
      async porClinica(): Promise<Record<string, never>> {
        await Promise.resolve();
        return {};
      },
    },
  ];
}
