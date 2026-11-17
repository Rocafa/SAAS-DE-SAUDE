import type { TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from './auth-context';
import { MFA_RECENTE_EXPORTACAO_MS, MFA_RECENTE_MS, mfaRecenteAte, PERFIS_COM_MFA_OBRIGATORIO, recusaDeMfa } from './mfa';
import { PERFIS, type Perfil } from './perfis';

const agora = new Date('2030-05-06T12:00:00Z');
const antes = (ms: number) => new Date(agora.getTime() - ms);
const sessao = (perfis: Perfil[], mfaEm: Date | null): AuthContext => ({
  tenantId: '00000000-0000-4000-8000-000000000001' as TenantId,
  userId: '00000000-0000-4000-8000-000000000002' as UserId,
  perfis,
  mfaEm,
});

describe('política de MFA (issue #106; parecer de 03/11)', () => {
  it('B1: obrigatório para todos os perfis, inclusive a recepção', () => {
    expect([...PERFIS_COM_MFA_OBRIGATORIO].sort()).toEqual([...PERFIS].sort());
    for (const p of PERFIS) expect(recusaDeMfa(sessao([p], null), null, agora), p).toBe('mfa_obrigatorio');
    // MFA feito há horas basta para rota comum.
    expect(recusaDeMfa(sessao(['recepcao'], antes(8 * 3_600_000)), null, agora)).toBeNull();
  });

  it('rota de MFA recente: dentro da janela passa; antigo, ausente ou no futuro é recusado', () => {
    expect(recusaDeMfa(sessao(['profissional'], null), MFA_RECENTE_MS, agora)).toBe('mfa_obrigatorio');
    expect(recusaDeMfa(sessao(['profissional'], antes(MFA_RECENTE_MS)), MFA_RECENTE_MS, agora)).toBeNull();
    expect(recusaDeMfa(sessao(['profissional'], antes(MFA_RECENTE_MS + 1)), MFA_RECENTE_MS, agora)).toBe('mfa_recente_obrigatorio');
    expect(recusaDeMfa(sessao(['profissional'], new Date(agora.getTime() + 60_000)), MFA_RECENTE_MS, agora)).toBe('mfa_recente_obrigatorio');
  });

  it('R1: a janela é da rota (exportação total com 5 minutos)', () => {
    expect(MFA_RECENTE_EXPORTACAO_MS).toBe(5 * 60_000);
    const dezMin = sessao(['admin'], antes(10 * 60_000));
    expect(recusaDeMfa(dezMin, MFA_RECENTE_MS, agora)).toBeNull();
    expect(recusaDeMfa(dezMin, MFA_RECENTE_EXPORTACAO_MS, agora)).toBe('mfa_recente_obrigatorio');
  });

  it('R8: o cliente recebe só até quando o MFA conta como recente', () => {
    expect(mfaRecenteAte(sessao(['recepcao'], agora))).toBe(new Date(agora.getTime() + MFA_RECENTE_MS).toISOString());
    expect(mfaRecenteAte(sessao(['recepcao'], null))).toBeNull();
  });
});
