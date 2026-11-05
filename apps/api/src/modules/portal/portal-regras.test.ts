import { describe, expect, it } from 'vitest';
import { assertAuditMetadata } from '../audit/audit-metadata';
import {
  areaSensivelDoProfissional,
  consentimentoIa,
  consultaOcultaAoResponsavel,
  correcaoDeNascimentoExigeDocumento,
  especialidadeSensivel,
  estadoDoConsentimento,
  eventoVale,
  fimDaRepresentacao,
  hashDoTexto,
  hashDoToken,
  idadeEm,
  loadAntecedenciaCancelamento,
  mascararCpf,
  nascimentoPropostoValido,
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
    const ok = { representationEndedAt: null, guardianLinkOk: true };
    const resp = { actingAs: 'responsavel_legal' as const, representUntil: '2030-05-10', ...ok };
    expect(eventoVale(resp, '2030-05-09')).toBe(true);
    expect(eventoVale(resp, '2030-05-10')).toBe(false);
    expect(eventoVale({ actingAs: 'responsavel_legal', representUntil: null, ...ok }, '2099-01-01')).toBe(true);
    expect(eventoVale({ actingAs: 'titular', representUntil: null, representationEndedAt: null, guardianLinkOk: null }, '2099-01-01')).toBe(true);
  });

  it('R4: o evento do responsável (inclusive o curador) deixa de valer quando o vínculo da 0028 acaba', () => {
    const curador = { actingAs: 'responsavel_legal' as const, representUntil: null };
    expect(eventoVale({ ...curador, representationEndedAt: null, guardianLinkOk: true }, '2099-01-01')).toBe(true);
    expect(eventoVale({ ...curador, representationEndedAt: null, guardianLinkOk: false }, '2026-01-01')).toBe(false);
    expect(eventoVale({ ...curador, representationEndedAt: null, guardianLinkOk: null }, '2026-01-01')).toBe(false);
    expect(eventoVale({ ...curador, representationEndedAt: new Date(), guardianLinkOk: true }, '2026-01-01')).toBe(false);
  });

  it('sigilo: responsável não vê área sensível de adolescente ou idade desconhecida; criança e titular veem', () => {
    expect(especialidadeSensivel('Psicologia')).toBe(true);
    expect(especialidadeSensivel('Psiquiatria infantil')).toBe(true);
    expect(especialidadeSensivel('Saúde Mental')).toBe(true);
    expect(especialidadeSensivel('Terapia TCC')).toBe(true);
    expect(especialidadeSensivel('Fisioterapia')).toBe(false);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'adolescente', true)).toBe(true);
    expect(consultaOcultaAoResponsavel('responsavel_legal', null, true)).toBe(true);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'adulto', true)).toBe(true);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'crianca', true)).toBe(false);
    expect(consultaOcultaAoResponsavel('responsavel_legal', 'adolescente', false)).toBe(false);
    expect(consultaOcultaAoResponsavel('titular', 'adulto', true)).toBe(false);
  });

  it('R2: a marca ESTRUTURADA decide; texto livre só reforça; profissional desconhecido = sensível', () => {
    // "Terapeuta" em texto livre não é pego pela expressão: a marca da clínica resolve.
    expect(areaSensivelDoProfissional({ sensitiveArea: true, specialty: 'Terapeuta' })).toBe(true);
    expect(areaSensivelDoProfissional({ sensitiveArea: false, specialty: 'Terapeuta' })).toBe(false);
    expect(areaSensivelDoProfissional({ sensitiveArea: false, specialty: 'Psicóloga' })).toBe(true);
    expect(areaSensivelDoProfissional({ sensitiveArea: false, specialty: 'Fisioterapia' })).toBe(false);
    expect(areaSensivelDoProfissional(null)).toBe(true);
  });
});

describe('C1 (conferência de 24/10): correção do nascimento', () => {
  const HOJE = '2027-06-15';

  it('data proposta: AAAA-MM-DD que existe, não futura, desde 1900', () => {
    expect(nascimentoPropostoValido('2012-02-29', HOJE)).toBe(true);
    expect(nascimentoPropostoValido(HOJE, HOJE)).toBe(true);
    for (const v of ['2013-02-29', '15/06/2012', '2012-6-1', '2027-06-16', '1899-12-31', 'ontem']) expect(nascimentoPropostoValido(v, HOJE), v).toBe(false);
  });

  it('reduzir a idade de paciente com 12+ exige documento; aumentar ou corrigir criança não', () => {
    // 15 anos -> 11 anos: sairia do sigilo do adolescente.
    expect(correcaoDeNascimentoExigeDocumento('2012-01-10', '2016-01-10', HOJE)).toBe(true);
    // 15 -> 14 (continua adolescente): ainda reduz, exige.
    expect(correcaoDeNascimentoExigeDocumento('2012-01-10', '2013-01-10', HOJE)).toBe(true);
    // Fez 12 hoje: já conta como adolescente.
    expect(correcaoDeNascimentoExigeDocumento('2015-06-15', '2015-06-16', HOJE)).toBe(true);
    // Adulto -> menor (devolveria a representação): exige.
    expect(correcaoDeNascimentoExigeDocumento('2000-01-01', '2012-01-01', HOJE)).toBe(true);
    // Aumentar a idade ou manter a data: não exige.
    expect(correcaoDeNascimentoExigeDocumento('2012-01-10', '2011-01-10', HOJE)).toBe(false);
    expect(correcaoDeNascimentoExigeDocumento('2012-01-10', '2012-01-10', HOJE)).toBe(false);
    // Criança (11 anos, véspera dos 12): não exige.
    expect(correcaoDeNascimentoExigeDocumento('2015-06-16', '2016-06-16', HOJE)).toBe(false);
  });

  it('data atual desconhecida ou ilegível: falha fechada (exige)', () => {
    expect(correcaoDeNascimentoExigeDocumento(null, '2010-01-01', HOJE)).toBe(true);
    expect(correcaoDeNascimentoExigeDocumento('04/03/1990', '2010-01-01', HOJE)).toBe(true);
  });
});
