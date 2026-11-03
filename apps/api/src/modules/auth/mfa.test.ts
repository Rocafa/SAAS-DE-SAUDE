import type { TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from './auth-context';
import { conferirMfa, MFA_RECENTE_MS, PERFIS_COM_MFA_OBRIGATORIO } from './mfa';
import type { Perfil } from './perfis';

const agora = new Date('2030-05-06T12:00:00Z');
const sessao = (perfis: Perfil[], mfaEm: Date | null): AuthContext => ({
  tenantId: '00000000-0000-4000-8000-000000000001' as TenantId,
  userId: '00000000-0000-4000-8000-000000000002' as UserId,
  perfis,
  mfaEm,
});
const codigo = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return ((e as { getResponse?: () => { codigo?: string } }).getResponse?.() ?? {}).codigo;
  }
};

describe('política de MFA (issue #106)', () => {
  it('obrigatório para admin, profissional e financeiro; a recepção não é obrigada', () => {
    expect([...PERFIS_COM_MFA_OBRIGATORIO].sort()).toEqual(['admin', 'financeiro', 'profissional']);
    for (const p of PERFIS_COM_MFA_OBRIGATORIO) expect(codigo(() => conferirMfa(sessao([p], null), false, agora)), p).toBe('mfa_obrigatorio');
    expect(codigo(() => conferirMfa(sessao(['recepcao'], null), false, agora))).toBeUndefined();
    // Um perfil obrigado basta, mesmo junto com recepção.
    expect(codigo(() => conferirMfa(sessao(['recepcao', 'financeiro'], null), false, agora))).toBe('mfa_obrigatorio');
    expect(codigo(() => conferirMfa(sessao(['admin'], new Date(agora.getTime() - 8 * 3_600_000)), false, agora))).toBeUndefined();
  });

  it('rota de MFA recente: até 15 minutos; antigo, ausente ou no futuro é recusado', () => {
    const p = sessao(['profissional'], null);
    expect(codigo(() => conferirMfa(p, true, agora))).toBe('mfa_obrigatorio');
    expect(codigo(() => conferirMfa(sessao(['recepcao'], null), true, agora))).toBe('mfa_obrigatorio');
    expect(codigo(() => conferirMfa(sessao(['profissional'], new Date(agora.getTime() - MFA_RECENTE_MS)), true, agora))).toBeUndefined();
    expect(codigo(() => conferirMfa(sessao(['profissional'], new Date(agora.getTime() - MFA_RECENTE_MS - 1)), true, agora))).toBe('mfa_recente_obrigatorio');
    expect(codigo(() => conferirMfa(sessao(['profissional'], new Date(agora.getTime() + 60_000)), true, agora))).toBe('mfa_recente_obrigatorio');
  });
});
