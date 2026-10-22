import { describe, expect, it } from 'vitest';
import { assertAuditMetadata } from '../audit/audit-metadata';
import {
  consentimentoIa,
  consultaOcultaAoResponsavel,
  especialidadeSensivel,
  estadoDoConsentimento,
  eventoVale,
  fimDaRepresentacao,
  hashDoTexto,
  hashDoToken,
  idadeEm,
  loadAntecedenciaCancelamento,
  mascararCpf,
  novoProtocolo,
  novoTokenDeConvite,
  permitido,
  primeiroNome,
  tipoDePedido,
  TOKEN_CONVITE_RE,
  transicaoDoPortal,
  VERSAO_TEXTOS_CONSENTIMENTO,
} from './portal-regras';

describe('regras do portal do paciente', () => {
  it('consentimento em 3 estados: só "sim" permite; IA mapeada para o vocabulário do escriba', () => {
    expect(estadoDoConsentimento(undefined)).toBe('nao_respondido');
    expect(estadoDoConsentimento('desfeito')).toBe('nao_respondido');
    expect(estadoDoConsentimento('nao')).toBe('nao');
    expect([permitido('sim'), permitido('nao'), permitido('nao_respondido')]).toEqual([true, false, false]);
    expect([consentimentoIa('sim'), consentimentoIa('nao'), consentimentoIa('nao_respondido')]).toEqual([
      'informado_nao_recusou',
      'recusou',
      'nao_informado',
    ]);
  });

  it('versão e hash do texto cabem na trilha (sem parecer dado pessoal) e mudam por finalidade', () => {
    expect(() => assertAuditMetadata({ text_version: VERSAO_TEXTOS_CONSENTIMENTO })).not.toThrow();
    expect(hashDoTexto('escriba_ia')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoTexto('escriba_ia')).not.toBe(hashDoTexto('pesquisa'));
  });

  it('transições do portal: só confirmar, desfazer a confirmação e cancelar o que não aconteceu', () => {
    expect(transicaoDoPortal('confirmar', 'scheduled')).toBe('confirmed');
    expect(transicaoDoPortal('confirmar', 'confirmed')).toBeNull();
    expect(transicaoDoPortal('desfazer_confirmacao', 'confirmed')).toBe('scheduled');
    expect(transicaoDoPortal('cancelar', 'confirmed')).toBe('cancelled');
    for (const s of ['checked_in', 'in_progress', 'completed', 'no_show', 'cancelled']) {
      expect(transicaoDoPortal('cancelar', s)).toBeNull();
      expect(transicaoDoPortal('confirmar', s)).toBeNull();
    }
  });

  it('pedidos: tipos do art. 18 e apelidos do front; desconhecido não passa', () => {
    expect(tipoDePedido('ver_dados')).toBe('acesso');
    expect(tipoDePedido('baixar')).toBe('portabilidade');
    expect(tipoDePedido('apagar')).toBe('eliminacao');
    expect(tipoDePedido('toString')).toBeUndefined();
    expect(novoProtocolo(new Date('2026-10-20T12:00:00Z'))).toMatch(/^20261020-[0-9A-F]{8}$/);
  });

  it('token do convite: 256 bits, só o hash vai para o banco', () => {
    const { token, hash } = novoTokenDeConvite();
    expect(token).toMatch(TOKEN_CONVITE_RE);
    expect(hash).toBe(hashDoToken(token));
    expect(hash).not.toContain(token);
  });

  it('máscara, saudação, idade e antecedência', () => {
    expect(mascararCpf('00000000191')).toBe('***.***.***-91');
    expect(mascararCpf(null)).toBeNull();
    expect(primeiroNome('Ana Ficticia', null)).toBe('Ana');
    expect(primeiroNome('Joao Ficticio', 'Bia Social')).toBe('Bia');
    expect(idadeEm('2008-10-21', '2026-10-20')).toBe(17);
    expect(idadeEm('2008-10-20', '2026-10-20')).toBe(18);
    expect(loadAntecedenciaCancelamento({})).toBe(2);
    expect(loadAntecedenciaCancelamento({ PORTAL_CANCEL_MIN_HOURS: '24' })).toBe(24);
    expect(() => loadAntecedenciaCancelamento({ PORTAL_CANCEL_MIN_HOURS: '-1' })).toThrow();
  });
});

describe('V1 do #68: representação do responsável e sigilo do adolescente', () => {
  it('fim da representação: dia dos 18 anos ou o fim da vigência do vínculo, o que vier antes', () => {
    expect(fimDaRepresentacao('2030-05-10', null)).toBe('2030-05-10');
    expect(fimDaRepresentacao('2030-05-10', '2029-01-01')).toBe('2029-01-01');
    expect(fimDaRepresentacao('2030-05-10', '2031-01-01')).toBe('2030-05-10');
  });

  it('evento do responsável vale só ANTES do fim (exclusivo); no dia dos 18 volta a não respondido; curatela e titular sempre', () => {
    const resp = { actingAs: 'responsavel_legal' as const, representUntil: '2030-05-10' };
    expect(eventoVale(resp, '2030-05-09')).toBe(true);
    expect(eventoVale(resp, '2030-05-10')).toBe(false);
    expect(eventoVale({ actingAs: 'responsavel_legal', representUntil: null }, '2099-01-01')).toBe(true);
    expect(eventoVale({ actingAs: 'titular', representUntil: null }, '2099-01-01')).toBe(true);
  });

  it('sigilo: responsável não vê psicologia/psiquiatria de adolescente ou idade desconhecida; criança e titular veem', () => {
    expect(especialidadeSensivel('Psicologia')).toBe(true);
    expect(especialidadeSensivel('Psiquiatria infantil')).toBe(true);
    expect(especialidadeSensivel('Fisioterapia')).toBe(false);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'adolescente', 'Psicologia')).toBe(true);
    expect(consultaOcultaAoResponsavel('responsavel_legal', null, 'Psicóloga')).toBe(true);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'crianca', 'Psicologia')).toBe(false);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'adolescente', 'Fisioterapia')).toBe(false);
    expect(consultaOcultaAoResponsavel('titular', 'adulto', 'Psicologia')).toBe(false);
  });
});
