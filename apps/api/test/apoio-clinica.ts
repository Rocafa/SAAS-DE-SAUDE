/**
 * Clínica fictícia SEM fundador para a bancada, pelo único caminho que o banco aceita (0081; G3 do parecer do #207):
 * o papel de migração (`DATABASE_MIGRATOR_URL`, como migrações e seeds). O runtime (`app_user`), a autenticação
 * (`app_auth`) e o provisionamento (`app_provisionamento`) recebem 42501. Clínica COM fundador continua pelo fluxo
 * normal (`novaClinica` de apoio-api.ts). Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { tenants } from '../src/db/schema';
import { createDatabase, withTenant } from '../src/db/tenant-transaction';

export type ClinicaSemFundador = Omit<typeof tenants.$inferInsert, 'id' | 'founderUserId'>;

export function urlDoMigrator(): string {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL (papel app_migrator) é obrigatória para criar clínica sem fundador');
  return url;
}

/** Insere clínicas sem fundador pelo papel de migração, cada uma na sua transação com o contexto da clínica. */
export async function criarClinicasSemFundador(clinicas: ReadonlyArray<{ id: TenantId } & ClinicaSemFundador>): Promise<void> {
  const h = createDatabase(urlDoMigrator(), { max: 1 });
  try {
    for (const { id, ...valores } of clinicas) {
      await withTenant(h.db, id, (tx) => tx.insert(tenants).values({ id, ...valores }));
    }
  } finally {
    await h.close();
  }
}

export const criarClinicaSemFundador = (id: TenantId, valores: ClinicaSemFundador): Promise<void> =>
  criarClinicasSemFundador([{ id, ...valores }]);
