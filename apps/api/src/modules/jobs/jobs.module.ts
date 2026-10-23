/**
 * Módulo do agendador de jobs (rodada 20; api-dominio.md §14).
 *
 * Escolha pelo ambiente (`criarInfraDosJobs`):
 * - REDIS_URL e NODE_ENV ≠ test → BullMQ + trava e último sucesso no Redis; sinal de vida a cada 10 min;
 * - sem REDIS_URL com qualquer NODE_ENV fora de development/test (produção, staging, vazio…) → jobs
 *   DESLIGADOS, com log de erro `JOBS_DESLIGADOS` na subida e a cada verificação, e `jobs: "desligado"` no
 *   /health/ready (nunca falha silenciosa). A API sobe: o atendimento não para por falta do agendador, mas o
 *   monitoramento vê;
 * - development/test sem Redis (ou test com Redis) → em memória: nada dispara sozinho, `disparar(nome)` roda na hora;
 * - `JOBS_HABILITADOS=false` → desligado por opção explícita (ex.: instância só de HTTP): aviso
 *   `JOBS_DESLIGADOS_POR_OPCAO` na subida (N2: não aciona o alarme de JOBS_DESLIGADOS), "desligado" no /health/ready.
 */
import { type DynamicModule, Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuditAction, type TenantId } from '@plataforma/shared';
import Redis from 'ioredis';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { RetencaoFiscalService } from '../finance/retencao-fiscal';
import { ImportacaoService } from '../imports/importacao.service';
import { WhatsappService } from '../messaging/whatsapp.service';
import { ResponsaveisService } from '../patients/responsaveis.service';
import { PortalClinicaService } from '../portal/portal-clinica.service';
import { CicloNotasPrivadasService } from '../records/ciclo-notas-privadas';
import { ClinicasDoAgendador, TenantDatabase } from '../tenancy/tenancy.module';
import { AgendadorBullMQ, fabricasReais, RegistroRedis, TravaRedis } from './agendador-bullmq';
import { AgendadorEmMemoria, RegistroEmMemoria, TravaEmMemoria } from './agendador-memoria';
import { codigoDoErro, type AgendadorPort, type DefinicaoDeJob, type ModoDoAgendador, type RegistroDeExecucoes, type TravaDeJob } from './agendador.port';
import { registrarModoDosJobs } from './estado-dos-jobs';
import { type DependenciasDoExecutor, ExecutorDeJobs, type LinhaDeTrilhaDoJob, type ResumoDaExecucao } from './executor-de-jobs';
import { criarRegistroDeJobs, JOBS_APOSENTADOS } from './registro-de-jobs';
import { verificarAtrasos, type JobAtrasado } from './sinal-de-vida';

export const SCOPE_JOBS = 'jobs';
export const INFRA_DOS_JOBS = Symbol('INFRA_DOS_JOBS');
const VERIFICACAO_MS = 10 * 60_000;
/** Únicos ambientes em que, sem Redis, o agendador cai em memória (R2 do parecer dos jobs). */
const AMBIENTES_COM_MEMORIA: ReadonlySet<string> = new Set(['development', 'test']);

export interface InfraDosJobs {
  /** `null` = desligado (o motivo vai para o log). */
  readonly agendador: AgendadorPort | null;
  readonly trava: TravaDeJob;
  readonly registro: RegistroDeExecucoes;
  readonly motivoDesligado?: string;
  /** N2: `JOBS_HABILITADOS=false` (instância só de HTTP): aviso `JOBS_DESLIGADOS_POR_OPCAO`, não erro. */
  readonly desligadoPorOpcao?: boolean;
  readonly fechar?: () => Promise<void>;
}

export function criarInfraDosJobs(env: NodeJS.ProcessEnv = process.env): InfraDosJobs {
  const memoria = { trava: new TravaEmMemoria(), registro: new RegistroEmMemoria() };
  const flag = env.JOBS_HABILITADOS?.trim();
  if (flag === 'false') return { agendador: null, ...memoria, motivoDesligado: 'JOBS_HABILITADOS=false', desligadoPorOpcao: true };
  if (flag && flag !== 'true') throw new Error('JOBS_HABILITADOS inválida: true ou false');
  const url = env.REDIS_URL?.trim();
  // Em teste, nunca BullMQ por acaso (o CI tem REDIS_URL para o rate limit): jobs de verdade rodando no meio da
  // suíte gravariam trilha nas clínicas de teste. O teste do adaptador real monta o BullMQ explicitamente.
  if (url && env.NODE_ENV !== 'test') {
    const fabricas = fabricasReais(url);
    const redis = new Redis(url, { maxRetriesPerRequest: 3 });
    const logger = new Logger('jobs');
    redis.on('error', () => logger.warn('Redis do agendador indisponível (trava/sinal de vida)'));
    return {
      agendador: new AgendadorBullMQ(fabricas, () => fabricas.fechar()),
      trava: new TravaRedis(redis),
      registro: new RegistroRedis(redis),
      fechar: async () => {
        await redis.quit().catch(() => redis.disconnect());
      },
    };
  }
  // R2 do parecer dos jobs: LISTA FECHADA. Memória (que fica calada: nada dispara, sem sinal de vida) só em
  // development/test. Qualquer outro NODE_ENV (staging, prod, vazio, digitado errado) sem Redis = desligado,
  // com JOBS_DESLIGADOS no log e no /health/ready, igual à produção. O motivo é texto fixo (nunca o valor lido).
  if (!AMBIENTES_COM_MEMORIA.has(env.NODE_ENV ?? '')) {
    return { agendador: null, ...memoria, motivoDesligado: env.NODE_ENV === 'production' ? 'REDIS_URL ausente em produção' : 'REDIS_URL ausente fora de development/test' };
  }
  return { agendador: new AgendadorEmMemoria(), ...memoria };
}

@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('jobs');
  private executor: ExecutorDeJobs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly subiuEm = Date.now();

  constructor(
    @Inject(INFRA_DOS_JOBS) private readonly infra: InfraDosJobs,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(ClinicasDoAgendador) private readonly clinicas: ClinicasDoAgendador,
  ) {}

  get modo(): ModoDoAgendador {
    return this.infra.agendador?.modo ?? 'desligado';
  }

  get jobs(): readonly DefinicaoDeJob[] {
    return this.executor?.jobs ?? [];
  }

  async onApplicationBootstrap(): Promise<void> {
    registrarModoDosJobs(this.infra.agendador ? 'nao_iniciado' : 'desligado');
    const get = <T>(tipo: new (...args: never[]) => T): T => this.moduleRef.get(tipo, { strict: false });
    const jobs = criarRegistroDeJobs({
      whatsapp: get(WhatsappService),
      portal: get(PortalClinicaService),
      importacao: get(ImportacaoService),
      notas: get(CicloNotasPrivadasService),
      retencaoFiscal: get(RetencaoFiscalService),
      responsaveis: get(ResponsaveisService),
    });
    this.executor = this.novoExecutor({ jobs });
    const agendador = this.infra.agendador;
    if (!agendador && this.infra.desligadoPorOpcao) {
      // N2 do parecer dos jobs: instância só de HTTP, de propósito. Aviso (não erro) com marcador próprio, para
      // não acionar o alarme de JOBS_DESLIGADOS; o IaC garante ao menos um serviço com jobs ligados (R3).
      this.logger.warn(`JOBS_DESLIGADOS_POR_OPCAO: JOBS_HABILITADOS=false nesta instância (${jobs.length} no registro, nenhum agendado aqui)`);
      return;
    }
    if (!agendador) {
      // Nunca silencioso: erro na subida e a cada verificação, e "desligado" no /health/ready.
      this.logger.error(`JOBS_DESLIGADOS motivo="${this.infra.motivoDesligado ?? 'desconhecido'}": nenhum job agendado (${jobs.length} no registro)`);
      this.timer = setInterval(() => this.logger.error(`JOBS_DESLIGADOS motivo="${this.infra.motivoDesligado ?? 'desconhecido'}"`), VERIFICACAO_MS);
      this.timer.unref();
      return;
    }
    const executar = async (nome: string): Promise<void> => {
      await this.executar(nome);
    };
    if (agendador.modo === 'memoria') {
      await agendador.agendar(jobs, executar);
      registrarModoDosJobs('memoria');
      this.logger.log(`agendador em memória: ${jobs.length} job(s) registrados, disparo só manual`);
      return;
    }
    // BullMQ: sem esperar o Redis na subida (o ioredis do trabalhador enfileira comandos até conectar; esperar
    // aqui travaria a API inteira com o Redis fora). Até agendar, o /health/ready mostra "nao_iniciado"; se
    // falhar, erro no log. O sinal de vida roda desde já: Redis fora também vira JOB_ATRASADO.
    this.timer = setInterval(() => void this.verificarAtrasos(), VERIFICACAO_MS);
    this.timer.unref();
    agendador.agendar(jobs, executar, JOBS_APOSENTADOS).then(
      () => registrarModoDosJobs('bullmq'),
      (err: unknown) => this.logger.error(`JOBS_NAO_AGENDADOS erro=${codigoDoErro(err)}: nenhum job agendado nesta instância`),
    );
  }

  /** Executa um job agora (o BullMQ chama isto; em dev/test, o disparo manual). */
  async executar(nome: string): Promise<ResumoDaExecucao> {
    if (!this.executor) throw new Error('agendador ainda não subiu');
    return this.executor.executar(nome);
  }

  /** Sinal de vida dos jobs críticos (`JOB_ATRASADO`). */
  verificarAtrasos(agoraMs: number = Date.now()): Promise<JobAtrasado[]> {
    return verificarAtrasos(this.jobs, this.infra.registro, agoraMs, this.subiuEm, this.logger);
  }

  /**
   * Executor com as peças desta instância (trava, registro, trilha, clínicas de app_job_tenants()). O teste de
   * integração troca a lista de clínicas para não tocar as clínicas das outras suítes.
   */
  novoExecutor(sobrescrever: Partial<DependenciasDoExecutor> & Pick<DependenciasDoExecutor, 'jobs'>): ExecutorDeJobs {
    return new ExecutorDeJobs({
      trava: this.infra.trava,
      registro: this.infra.registro,
      listarClinicas: () => this.clinicas.listar(),
      registrarTrilha: (t, linha) => this.registrarTrilha(t, linha),
      logger: this.logger,
      ...sobrescrever,
    });
  }

  private async registrarTrilha(tenantId: TenantId, linha: LinhaDeTrilhaDoJob): Promise<void> {
    await this.db.run(tenantId, (tx) =>
      recordAudit(tx, { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
        action: AuditAction.Update,
        scope: SCOPE_JOBS,
        metadata: {
          op: 'job_run',
          job: linha.job,
          status: linha.situacao,
          tentativas: linha.tentativas,
          ...(linha.erro ? { erro: linha.erro } : {}),
          ...linha.resultado,
        },
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.infra.agendador?.parar();
    await this.infra.fechar?.();
  }
}

@Module({})
export class JobsModule {
  static forRoot(infra: InfraDosJobs): DynamicModule {
    return {
      module: JobsModule,
      providers: [{ provide: INFRA_DOS_JOBS, useValue: infra }, JobsService],
      exports: [JobsService],
    };
  }
}
