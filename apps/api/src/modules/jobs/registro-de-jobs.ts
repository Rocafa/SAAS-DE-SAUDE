/**
 * REGISTRO CENTRAL dos jobs (api-dominio.md §14, tabela). Mudou aqui, muda a tabela do documento.
 * Todo job roda por clínica (o executor percorre `app_job_tenants()`), sem usuário (sentinela da 0019,
 * ator `sistema` na trilha) e é idempotente.
 *
 * Horários em America/Sao_Paulo, espalhados de madrugada para não competir entre si nem com o atendimento.
 */
import type { TenantId } from '@plataforma/shared';
import { SYSTEM_ACTOR_ID } from '../audit/audit-log';
import type { RetencaoFiscalService } from '../finance/retencao-fiscal';
import type { ImportacaoService } from '../imports/importacao.service';
import type { WhatsappService } from '../messaging/whatsapp.service';
import type { ResponsaveisService } from '../patients/responsaveis.service';
import type { PortalClinicaService } from '../portal/portal-clinica.service';
import type { CicloNotasPrivadasService } from '../records/ciclo-notas-privadas';
import { validarDefinicoes, type DefinicaoDeJob } from './agendador.port';

const MIN = 60_000;
const HORA = 60 * MIN;
/** Rotina diária: alarma se passar de 26 h sem sucesso (24 h + folga para o retry com backoff). */
const PRAZO_DIARIO = 26 * HORA;
const TRAVA_DIARIA = 30 * MIN;

export interface ServicosDosJobs {
  readonly whatsapp: Pick<WhatsappService, 'executarLembretesComoSistema' | 'executarRetencaoComoSistema'>;
  readonly portal: Pick<PortalClinicaService, 'encerrarRepresentacoesDaClinica'>;
  readonly importacao: Pick<ImportacaoService, 'expurgoDiario'>;
  readonly notas: Pick<CicloNotasPrivadasService, 'executarCicloComoSistema'>;
  readonly retencaoFiscal: Pick<RetencaoFiscalService, 'executarComoSistema'>;
  readonly responsaveis: Pick<ResponsaveisService, 'descartarAnuladosComoSistema'>;
}

export function criarRegistroDeJobs(s: ServicosDosJobs): readonly DefinicaoDeJob[] {
  const diario = (cron: string, descricao: string) => ({ periodicidade: { cron, descricao }, prazoMaximoMs: PRAZO_DIARIO, travaMs: TRAVA_DIARIA, critico: true, trilha: 'sempre' as const });
  const jobs: DefinicaoDeJob[] = [
    {
      // HU-COM-003/004 (§13): programa e despacha os lembretes. Reconfere os modelos na Meta (N1 do #69) no
      // máximo a cada 24 h ANTES de despachar; divergente = nada sai. Trilha só com efeito (o próprio envio audita).
      nome: 'whatsapp-lembretes',
      periodicidade: { aCadaMs: 5 * MIN, descricao: 'a cada 5 min' },
      prazoMaximoMs: 30 * MIN,
      travaMs: 4 * MIN,
      critico: true,
      trilha: 'com_efeito',
      porClinica: async (t: TenantId) => {
        const r = await s.whatsapp.executarLembretesComoSistema(t);
        return { programados: r.programados, enviados: r.enviados, falharam: r.falharam, cancelados: r.cancelados, numeroMudou: r.numeroMudou, semOptIn: r.semOptIn, semDestinatario: r.semDestinatario };
      },
    },
    {
      // R2/R3 do #69 (§13): limpa o conteúdo dos envios com mais de 30 dias, expira "agendado" de consulta que
      // já começou e encerra "enviando" preso há mais de 24 h. Também reconfere os modelos (N1 do #69).
      nome: 'whatsapp-retencao',
      ...diario('15 3 * * *', 'diário, 03:15'),
      porClinica: async (t) => ({ ...(await s.whatsapp.executarRetencaoComoSistema(t)) }),
    },
    {
      // V1/R4 do #68 (§10a): revoga o vínculo do portal na maioridade, na emancipação ou no fim do vínculo da
      // 0028 e encerra o consentimento dado por responsável (`expirarConsentimentosDeResponsavel`). Logo após
      // a meia-noite: o acesso já cai no dia pela sessão; isto registra o fato na lista e na trilha.
      nome: 'portal-representacoes',
      ...diario('5 0 * * *', 'diário, 00:05'),
      porClinica: async (t) => ({ ...(await s.portal.encerrarRepresentacoesDaClinica(t)) }),
    },
    {
      // R2 do parecer do importador (§12c): descarta o bruto vencido (`IMPORT_RAW_TTL_HOURS`) ou de lote
      // encerrado; `alarme` = bruto vencido há mais de 24 h depois do expurgo (o executor loga JOB_ALARME).
      nome: 'importador-expurgo',
      ...diario('45 3 * * *', 'diário, 03:45'),
      porClinica: async (t) => {
        const r = await s.importacao.expurgoDiario([t]);
        return { arquivosDescartados: r.arquivosDescartados, atrasados: r.atrasados, alarme: r.alarme };
      },
    },
    {
      // D1–D3 do #63 (§8e/§8f): prazos da custódia das notas privadas e expurgo das descartadas há 30 dias.
      nome: 'notas-privadas-ciclo',
      ...diario('0 4 * * *', 'diário, 04:00'),
      porClinica: async (t) => ({ ...(await s.notas.executarCicloComoSistema(t)) }),
    },
    {
      // R7 do #65 (§9a): retenção fiscal (retrato do recibo e pagador vencidos).
      nome: 'retencao-fiscal',
      ...diario('30 4 * * *', 'diário, 04:30'),
      porClinica: async (t) => {
        const r = await s.retencaoFiscal.executarComoSistema(t, { tenantId: t, userId: SYSTEM_ACTOR_ID, roles: [] });
        return { recibosEliminados: r.recibosEliminados, cobrancasEliminadas: r.cobrancasEliminadas, pagadoresEliminados: r.pagadoresEliminados };
      },
    },
    {
      // A4 do #67 (§11a): descarta a pessoa de cadastro de responsável anulado há mais de 30 dias.
      nome: 'responsaveis-descarte',
      ...diario('0 5 * * *', 'diário, 05:00'),
      porClinica: async (t) => ({ ...(await s.responsaveis.descartarAnuladosComoSistema(t)) }),
    },
  ];
  validarDefinicoes(jobs);
  return jobs;
}
