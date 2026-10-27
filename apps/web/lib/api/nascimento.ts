/**
 * Regra da conferência de documento ao mudar a data de nascimento (C1-b′ e 0053 do backend, rodada 19+;
 * espelho de `correcaoDeNascimentoExigeDocumento` em apps/api/src/modules/portal/portal-regras.ts).
 * A API é quem decide (422 `documento_nao_conferido`); aqui serve para a tela pedir a conferência
 * antes de enviar e para o adaptador falso se comportar igual.
 */
import type { Papel } from './tipos';

/** Idade a partir da qual o paciente é titular no portal (sigilo do adolescente). */
export const IDADE_MINIMA_TITULAR = 12;
/** Só admin ou profissional declara "conferi o documento original"; a recepção sozinha não confere. */
export const PAPEIS_QUE_CONFEREM: readonly Papel[] = ['admin', 'profissional'];

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function idadeEm(nascimento: string, hoje: string): number {
  const [a1, m1, d1] = nascimento.split('-').map(Number) as [number, number, number];
  const [a2, m2, d2] = hoje.split('-').map(Number) as [number, number, number];
  return a2 - a1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
}

/**
 * A mudança exige documento conferido? Sim quando a data nova REDUZ a idade de quem hoje tem 12 anos ou
 * mais, ou quando a data atual é desconhecida (falha fechada). Apagar a data, aumentar a idade ou mexer
 * na de criança não exige. Data igual à atual não é mudança.
 */
export function mudancaDeNascimentoExigeDocumento(
  atual: string | null | undefined,
  proposto: string | null | undefined,
  hoje: string,
): boolean {
  if (!proposto || proposto === atual) return false;
  if (!atual || !DATA_RE.test(atual)) return true;
  if (proposto <= atual) return false;
  return idadeEm(atual, hoje) >= IDADE_MINIMA_TITULAR;
}

export function podeConferirDocumento(papel: Papel): boolean {
  return PAPEIS_QUE_CONFEREM.includes(papel);
}
