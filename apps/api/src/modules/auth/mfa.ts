/**
 * Política de MFA da API (issue #106, S3; regra 2 do memo da D4; requisitos-tecnicos-seguranca.md §4). Não depende
 * do provedor de login: o provedor só informa QUANDO o usuário passou pelo segundo fator (`AuthContext.mfaEm`); a
 * obrigatoriedade é decidida aqui, no servidor, pelo `SessaoGuard`.
 *
 * - **Obrigatório para todos os perfis** (B1 do parecer de 03/11): todos acessam dado C3/C4 (a recepção vê CPF,
 *   agenda, menores, convênio e opera o financeiro). Sem MFA na sessão: 403 `mfa_obrigatorio`.
 * - **MFA recente:** rotas marcadas com `@ExigeMfaRecente(janela)` exigem o segundo fator dentro da janela da rota
 *   (padrão 15 min; a exportação total da G2 usa 5 min, cláusula 16.2 da minuta do DPA). Fora dela: 403
 *   `mfa_recente_obrigatorio`; o cliente pede o código de novo e repete. A recusa nessas rotas vai para a trilha
 *   (B2: é o caso típico de sessão roubada), só com ids.
 *
 * Os eventos do próprio fator (cadastro, verificação, falha, bloqueio, reset com justificativa) vão para a trilha com
 * o provedor real (D4), pelos hooks dele.
 */
import { SetMetadata } from '@nestjs/common';
import { ProibidoError } from '../../common/erros-dominio';
import type { AuthContext } from './auth-context';
import type { Perfil } from './perfis';

/** Perfis que não usam a API sem MFA na sessão: todos (B1). */
export const PERFIS_COM_MFA_OBRIGATORIO: readonly Perfil[] = ['admin', 'profissional', 'recepcao', 'financeiro'];

/** Janela padrão do "MFA recente" (regra 2 do memo da D4: até 15 minutos). */
export const MFA_RECENTE_MS = 15 * 60_000;
/** Janela da exportação total (G2): 5 minutos, como promete a cláusula 16.2 da minuta do DPA (R1). */
export const MFA_RECENTE_EXPORTACAO_MS = 5 * 60_000;

export const MFA_RECENTE_KEY = 'plataforma:mfa-recente';

/** A rota exige MFA feito dentro da janela (conteúdo clínico sensível, ação irreversível, exportação). */
export const ExigeMfaRecente = (janelaMs: number = MFA_RECENTE_MS): MethodDecorator & ClassDecorator => SetMetadata(MFA_RECENTE_KEY, janelaMs);

export type RecusaDeMfa = 'mfa_obrigatorio' | 'mfa_recente_obrigatorio';

/** O motivo da recusa, ou null se a sessão cumpre a política. `janelaMs` null = rota sem exigência de MFA recente. */
export function recusaDeMfa(auth: AuthContext, janelaMs: number | null, agora: Date = new Date()): RecusaDeMfa | null {
  const obrigado = auth.perfis.some((p) => PERFIS_COM_MFA_OBRIGATORIO.includes(p));
  if ((obrigado || janelaMs !== null) && auth.mfaEm === null) return 'mfa_obrigatorio';
  if (janelaMs !== null && auth.mfaEm !== null) {
    const idade = agora.getTime() - auth.mfaEm.getTime();
    // Data no futuro (relógio do provedor adiantado) não conta como recente: falha fechada.
    if (idade < 0 || idade > janelaMs) return 'mfa_recente_obrigatorio';
  }
  return null;
}

/** Lança 403 com o código quando a sessão não cumpre a política. */
export function conferirMfa(auth: AuthContext, janelaMs: number | null, agora: Date = new Date()): void {
  const recusa = recusaDeMfa(auth, janelaMs, agora);
  if (recusa) throw new ProibidoError(recusa);
}

/** Até quando o MFA da sessão conta como recente na janela padrão (para o cliente saber se pede o código antes). */
export function mfaRecenteAte(auth: AuthContext): string | null {
  return auth.mfaEm ? new Date(auth.mfaEm.getTime() + MFA_RECENTE_MS).toISOString() : null;
}
