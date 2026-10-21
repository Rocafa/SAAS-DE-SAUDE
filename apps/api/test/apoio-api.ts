/**
 * Apoio dos testes de API de domínio contra Postgres REAL: AppModule com sessão fictícia
 * (DevSessionProvider) e chave local (LocalKeyProvider). Dados 100% fictícios, gerados a cada execução.
 * Não é teste (sem sufixo .test.ts): é importado pelas suítes test:rls e test:security.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule, type AppAdapters } from '../src/app.module';
import { loadConfig } from '../src/config';
import type { ClinicMemberRole } from '../src/db/schema';
import { createDatabase, type DatabaseHandle } from '../src/db/tenant-transaction';
import { MembrosService } from '../src/modules/auth/membros';
import { DevSessionProvider } from '../src/modules/auth/dev-session.provider';
import type { Perfil } from '../src/modules/auth/perfis';
import { LocalKeyProvider } from '../src/modules/crypto/local-key-provider';
import { DevPortalSessionProvider } from '../src/modules/portal/portal-auth';
import { DevPortalOtpSender } from '../src/modules/portal/portal-otp';

export interface ApiDeTeste {
  readonly app: INestApplication;
  readonly sessoes: DevSessionProvider;
  /** Sessões FICTÍCIAS do portal do paciente (provedor separado do da clínica). */
  readonly portal: DevPortalSessionProvider;
  /** Envio FICTÍCIO do código de resgate do convite (último código por telefone, em memória). */
  readonly otp: DevPortalOtpSender;
  readonly db: DatabaseHandle;
  http(): ReturnType<typeof request>;
  /** Cria uma clínica fictícia e devolve o id. */
  novaClinica(): Promise<TenantId>;
  /** Sessão fictícia: devolve o cabeçalho Authorization. */
  sessao(tenantId: TenantId, ...perfis: Perfil[]): { Authorization: string; userId: string };
  /** Sessão fictícia do portal para uma conta (nova, se não informada). */
  sessaoPortal(contaId?: string): { Authorization: string; contaId: string };
  /**
   * Registra perfis do usuário NO BANCO (clinic_members, 0020/R13), concedidos pelo admin fundador
   * fictício da clínica, pelo serviço do runtime (trilha e triggers conferem). Devolve o usuário.
   */
  membro<S extends { userId: string }>(tenantId: TenantId, s: S, ...perfis: ClinicMemberRole[]): Promise<S>;
  /** Usuário fundador (admin no banco) da clínica criada por novaClinica. */
  fundador(tenantId: TenantId): string;
  fechar(): Promise<void>;
}

export async function subirApi(adapters: Pick<AppAdapters, 'vigilancia' | 'pseudonymSigner' | 'portalLimites'> = {}): Promise<ApiDeTeste> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória');
  const sessoes = new DevSessionProvider('test');
  const portal = new DevPortalSessionProvider('test');
  const otp = new DevPortalOtpSender('test');
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(loadConfig(process.env), {
        authProvider: sessoes,
        portalAuthProvider: portal,
        portalOtpSender: otp,
        keyProvider: new LocalKeyProvider({ nodeEnv: 'test' }),
        ...adapters,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const db = createDatabase(url, { max: 2 });
  const fundadores = new Map<TenantId, string>();
  return {
    app,
    sessoes,
    portal,
    otp,
    db,
    http: () => request(app.getHttpServer() as Server),
    async novaClinica() {
      // Fluxo de criação da clínica (0022, R15): fundador fictício registrado como admin na mesma transação.
      const fundadorUserId = randomUUID();
      const { clinicaId } = await app.get(MembrosService).criarClinica({ nome: `Clinica Ficticia ${fundadorUserId.slice(0, 8)}`, fundadorUserId });
      fundadores.set(clinicaId, fundadorUserId);
      return clinicaId;
    },
    sessao(tenantId, ...perfis) {
      const userId = randomUUID();
      const token = sessoes.criarSessao({ tenantId, userId, perfis });
      return { Authorization: `Bearer ${token}`, userId };
    },
    sessaoPortal(contaId = randomUUID()) {
      return { Authorization: `Bearer ${portal.criarSessao({ contaId })}`, contaId };
    },
    async membro(tenantId, s, ...perfis) {
      const fundador = fundadores.get(tenantId);
      if (!fundador) throw new Error('membro(): clínica sem fundador (crie com novaClinica)');
      const ctx = { tenantId, userId: fundador as UserId, roles: ['admin'] };
      for (const role of perfis) await app.get(MembrosService).conceder(ctx, s.userId, role);
      return s;
    },
    fundador(tenantId) {
      const f = fundadores.get(tenantId);
      if (!f) throw new Error('clínica sem fundador');
      return f;
    },
    async fechar() {
      await app.close();
      await db.close();
    },
  };
}

/** CPF fictício com dígitos verificadores válidos e prefixo 000 (faixa não emitida). */
export function cpfFicticio(n: number): string {
  const base = `000${String(n).padStart(6, '0')}`;
  const dv = (s: string, peso: number) => {
    let soma = 0;
    for (let i = 0; i < s.length; i++) soma += Number(s[i]) * (peso - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base, 10);
  const d2 = dv(`${base}${d1}`, 11);
  return `${base}${d1}${d2}`;
}

/** Só os cabeçalhos para o supertest (sem o userId). */
export function cab(s: { Authorization: string }): { Authorization: string } {
  return { Authorization: s.Authorization };
}
