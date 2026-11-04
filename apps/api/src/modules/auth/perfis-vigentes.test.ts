/** E2 da revisão interna de 04/11 e parecer do #130: perfil revogado no banco sai da sessão na próxima requisição. */
import { describe, expect, it } from 'vitest';
import { perfisVigentes } from './sessao.guard';

const ativo = (role: string) => ({ role, revokedAt: null });
const revogado = (role: string) => ({ role, revokedAt: new Date('2026-11-04T10:00:00Z') });

describe('perfisVigentes', () => {
  it('sem linha no banco: fica o que o provedor disse (transição até a D4)', () => {
    expect(perfisVigentes(['admin', 'recepcao'], [])).toEqual(['admin', 'recepcao']);
  });

  it('perfil revogado sai; os ativos ficam', () => {
    expect(perfisVigentes(['admin', 'recepcao'], [revogado('admin'), ativo('recepcao')])).toEqual(['recepcao']);
  });

  it('revogado e concedido de novo: vale a concessão ativa', () => {
    expect(perfisVigentes(['admin'], [revogado('admin'), ativo('admin')])).toEqual(['admin']);
  });

  it('R1: com qualquer linha no banco, perfil que só a sessão diz ter não vale', () => {
    expect(perfisVigentes(['financeiro', 'recepcao'], [ativo('recepcao')])).toEqual(['recepcao']);
    expect(perfisVigentes(['admin'], [ativo('recepcao')])).toEqual([]);
  });

  it('desligado (tem histórico e nenhuma linha ativa): sai tudo', () => {
    expect(perfisVigentes(['admin', 'financeiro'], [revogado('recepcao')])).toEqual([]);
  });

  it('R2: a qualificação psicologo ativa não segura quem teve o perfil revogado', () => {
    expect(perfisVigentes(['profissional'], [ativo('psicologo'), revogado('profissional')])).toEqual([]);
    expect(perfisVigentes(['profissional'], [ativo('psicologo'), ativo('profissional')])).toEqual(['profissional']);
  });
});
