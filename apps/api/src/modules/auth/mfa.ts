/**
 * Política de MFA da API (issue #106, S3; regra 2 do memo da D4). Não depende do provedor de login: o provedor só
 * informa QUANDO o usuário passou pelo segundo fator (`AuthContext.mfaEm`); a obrigatoriedade é decidida aqui, no
 * servidor, pelo `SessaoGuard`.
 *
 * - **Obrigatório por perfil:** quem tem perfil clínico, financeiro ou de administração não usa a API sem MFA na
 *   sessão (403 `mfa_obrigatorio`). A recepção não é obrigada (não vê conteúdo clínico nem dado financeiro).
 * - **MFA recente:** rotas marcadas com `@ExigeMfaRecente()` (conteúdo clínico mais sensível e exportação) exigem o
 *   segundo fator nos últimos 15 minutos (403 `mfa_recente_obrigatorio`); o cliente pede o código de novo e repete.
 *
 * O registro na trilha dos eventos do próprio MFA (verificar, falhar, resetar com justificativa) vem com o provedor
 * real (D4), pelos hooks dele. A recusa aqui acontece antes de qualquer leitura: nada é lido nem gravado.
 */
import { SetMetadata } from '@nestjs/common';
import { ProibidoError } from '../../common/erros-dominio';
import type { AuthContext } from './auth-context';
import type { Perfil } from './perfis';

/** Perfis que não usam a API sem MFA na sessão. */
export const PERFIS_COM_MFA_OBRIGATORIO: readonly Perfil[] = ['admin', 'profissional', 'financeiro'];

/** Janela do "MFA recente" (regra 2 do memo da D4: até 15 minutos). */
export const MFA_RECENTE_MS = 15 * 60_000;

export const MFA_RECENTE_KEY = 'plataforma:mfa-recente';

/** A rota exige MFA feito nos últimos 15 minutos (conteúdo clínico sensível, exportação). */
export const ExigeMfaRecente = (): MethodDecorator & ClassDecorator => SetMetadata(MFA_RECENTE_KEY, true);

/** Lança 403 com o código quando a sessão não cumpre a política. `agora` injetável para teste. */
export function conferirMfa(auth: AuthContext, exigeRecente: boolean, agora: Date = new Date()): void {
  const obrigado = auth.perfis.some((p) => PERFIS_COM_MFA_OBRIGATORIO.includes(p));
  if ((obrigado || exigeRecente) && auth.mfaEm === null) throw new ProibidoError('mfa_obrigatorio');
  if (exigeRecente && auth.mfaEm !== null) {
    const idade = agora.getTime() - auth.mfaEm.getTime();
    // Data no futuro (relógio do provedor adiantado) não conta como recente: falha fechada.
    if (idade < 0 || idade > MFA_RECENTE_MS) throw new ProibidoError('mfa_recente_obrigatorio');
  }
}
