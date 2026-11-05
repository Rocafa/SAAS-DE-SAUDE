/**
 * Sinal de vida dos jobs críticos (api-dominio.md §14): job crítico sem execução bem-sucedida dentro do prazo
 * gera `JOB_ATRASADO` no log (nível error; o alarme do monitoramento filtra por esse código). Sem dado
 * pessoal: só o nome do job e o atraso em minutos.
 *
 * Referência: o último sucesso (Redis em produção); se o job nunca rodou, conta desde a subida do processo
 * (`desdeMs`), para não alarmar no primeiro minuto de um ambiente novo nem silenciar um job que nunca roda.
 */
import type { DefinicaoDeJob, RegistroDeExecucoes } from './agendador.port';
import type { LogDoJob } from './executor-de-jobs';

export interface JobAtrasado {
  readonly job: string;
  readonly atrasoMin: number;
  readonly nuncaRodou: boolean;
}

export async function verificarAtrasos(
  jobs: readonly DefinicaoDeJob[],
  registro: RegistroDeExecucoes,
  agoraMs: number,
  desdeMs: number,
  logger: LogDoJob,
): Promise<JobAtrasado[]> {
  const atrasados: JobAtrasado[] = [];
  for (const j of jobs) {
    if (!j.critico) continue;
    let ultimo: number | null;
    try {
      ultimo = await registro.ultimoSucesso(j.nome);
    } catch {
      // Sem como saber (Redis fora): isso também é alarme — falha silenciosa não.
      logger.error(`JOB_ATRASADO job=${j.nome} atraso_min=desconhecido motivo=registro_indisponivel`);
      atrasados.push({ job: j.nome, atrasoMin: -1, nuncaRodou: false });
      continue;
    }
    const referencia = ultimo ?? desdeMs;
    const passou = agoraMs - referencia;
    if (passou > j.prazoMaximoMs) {
      const atrasoMin = Math.floor((passou - j.prazoMaximoMs) / 60_000);
      logger.error(`JOB_ATRASADO job=${j.nome} atraso_min=${atrasoMin} nunca_rodou=${ultimo === null}`);
      atrasados.push({ job: j.nome, atrasoMin, nuncaRodou: ultimo === null });
    }
  }
  return atrasados;
}
