import { ConflitoError } from '../../common/erros-dominio';

/**
 * Erros do banco da 0101 (unidades, salas e conflito de sala) traduzidos para 409 com código estável. O gatilho
 * `appointments_sala_sem_conflito` é a garantia (vale também para quem grava fora do serviço); o serviço só
 * converte o erro, sem detalhe interno na resposta.
 */
const POR_CONSTRAINT: Readonly<Record<string, string>> = {
  appointments_room_conflict: 'sala_ocupada',
  appointments_room_active: 'sala_inativa',
  units_tenant_name_idx: 'nome_em_uso',
  rooms_unit_name_idx: 'nome_em_uso',
};

/** Nome da constraint em qualquer ponto da cadeia de causas (postgres.js: `constraint_name`). */
export function constraintDoErro(err: unknown): string | undefined {
  let atual: unknown = err;
  for (let i = 0; i < 8 && typeof atual === 'object' && atual !== null; i++) {
    const nome = (atual as { constraint_name?: unknown }).constraint_name;
    if (typeof nome === 'string') return nome;
    atual = atual instanceof Error ? atual.cause : undefined;
  }
  return undefined;
}

/** Relança como ConflitoError quando o erro é de sala/unidade; senão relança o original. */
export function traduzirErroDeSala(err: unknown): never {
  const nome = constraintDoErro(err);
  const codigo = nome ? POR_CONSTRAINT[nome] : undefined;
  if (codigo) throw new ConflitoError(codigo);
  throw err;
}
