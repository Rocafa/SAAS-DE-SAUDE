/**
 * RESIDÊNCIA DE DADOS — se este teste quebrar, alguém deixou dado de saúde sair do país
 * ou ignorou a recusa do paciente. Não "conserte" o teste: a mudança precisa de aprovação
 * do Guardião LGPD e dos sócios (D3).
 */
import { describe, expect, it } from 'vitest';
import {
  AI_NICHES,
  AI_TASKS,
  DATA_SENSITIVITIES,
  type DataSensitivity,
  type TenantAiPolicy,
} from './llm-provider';
import { FakeLlmProvider } from './providers/fake-llm.provider';
import { allowedResidencies, routeRequest } from './routing-policy';

const br = new FakeLlmProvider({ id: 'br-1', residency: 'BR' });
const br2 = new FakeLlmProvider({ id: 'br-2', residency: 'BR' });
const ext = new FakeLlmProvider({ id: 'ext-1', residency: 'EXTERIOR' });
const comTransferencia: TenantAiPolicy = { aiEnabled: true, allowsInternationalTransfer: true };
const semTransferencia: TenantAiPolicy = { aiEnabled: true, allowsInternationalTransfer: false };

describe('residência permitida', () => {
  it.each(DATA_SENSITIVITIES)('psicologia (%s) nunca sai do país, mesmo com transferência aceita', (s) => {
    expect([...allowedResidencies('psicologia', s, comTransferencia)]).toEqual(['BR']);
  });

  it.each(AI_NICHES)('dado sensível de %s fica só no Brasil', (niche) => {
    expect([...allowedResidencies(niche, 'sensivel', comTransferencia)]).toEqual(['BR']);
  });

  it('pseudonimizado só vai ao exterior se o tenant aceitou a transferência', () => {
    expect([...allowedResidencies('fisio_to', 'pseudonimizado', semTransferencia)]).toEqual(['BR']);
    expect([...allowedResidencies('fisio_to', 'pseudonimizado', comTransferencia)].sort()).toEqual(['BR', 'EXTERIOR']);
  });

  it('sensibilidade desconhecida é tratada como sensível (falha fechada)', () => {
    const desconhecida = 'qualquer' as DataSensitivity;
    expect([...allowedResidencies('fisio_to', desconhecida, comTransferencia)]).toEqual(['BR']);
  });
});

describe('routeRequest', () => {
  const base = {
    task: 'escriba' as const,
    niche: 'fisio_to' as const,
    sensitivity: 'sensivel' as const,
    tenantPolicy: comTransferencia,
    patientConsent: 'informado_nao_recusou' as const,
  };

  it('nega quando a IA está desligada na clínica', () => {
    const r = routeRequest({ ...base, tenantPolicy: { aiEnabled: false, allowsInternationalTransfer: true } }, [br]);
    expect(r).toEqual({ allowed: false, reason: 'ia_desligada_na_clinica' });
  });

  it.each(AI_TASKS)('recusa do paciente bloqueia a tarefa %s (CFM 2.454/2026)', (task) => {
    const r = routeRequest({ ...base, task, patientConsent: 'recusou' }, [br, ext]);
    expect(r).toEqual({ allowed: false, reason: 'paciente_recusou_ia' });
  });

  it('sem informação de consentimento, nega tarefa com dado de paciente', () => {
    const semConsentimento = { task: base.task, niche: base.niche, sensitivity: base.sensitivity, tenantPolicy: base.tenantPolicy };
    expect(routeRequest(semConsentimento, [br])).toEqual({ allowed: false, reason: 'consentimento_nao_informado' });
  });

  // Os TRÊS estados do consentimento, um por um. Ausência de registro nunca é permissão:
  // `nao_informado` tem de negar exatamente como o campo faltando.
  it('nao_informado nega, igual a não ter campo nenhum', () => {
    expect(routeRequest({ ...base, patientConsent: 'nao_informado' }, [br])).toEqual({
      allowed: false,
      reason: 'consentimento_nao_informado',
    });
  });

  it('recusou nega', () => {
    expect(routeRequest({ ...base, patientConsent: 'recusou' }, [br])).toEqual({
      allowed: false,
      reason: 'paciente_recusou_ia',
    });
  });

  it('informado_nao_recusou permite', () => {
    const r = routeRequest({ ...base, patientConsent: 'informado_nao_recusou' }, [br]);
    expect(r.allowed).toBe(true);
  });

  it.each(['nao_informado', 'recusou'] as const)(
    'o estado %s nega em TODAS as tarefas, não só no escriba',
    (consent) => {
      for (const task of AI_TASKS) {
        expect(routeRequest({ ...base, task, patientConsent: consent }, [br, ext]).allowed).toBe(false);
      }
    },
  );

  it('dado não pessoal dispensa consentimento de paciente', () => {
    const r = routeRequest({ task: 'chatbot', niche: 'outro', sensitivity: 'nao_pessoal', tenantPolicy: semTransferencia }, [ext]);
    expect(r.allowed).toBe(true);
  });

  it('dado sensível com só rota estrangeira disponível: nega, não cai para o exterior', () => {
    expect(routeRequest(base, [ext])).toEqual({ allowed: false, reason: 'nenhuma_rota_elegivel' });
  });

  it('rotas BR vêm antes e a estrangeira nunca entra como fallback de dado sensível', () => {
    const r = routeRequest(base, [ext, br, br2]);
    expect(r.allowed && r.candidates.map((p) => p.id)).toEqual(['br-1', 'br-2']);
  });

  it('pseudonimizado com transferência aceita: BR primeiro, exterior depois', () => {
    const r = routeRequest({ ...base, sensitivity: 'pseudonimizado' }, [ext, br]);
    expect(r.allowed && r.candidates.map((p) => p.id)).toEqual(['br-1', 'ext-1']);
  });

  it('rota não avaliada para a tarefa não é usada', () => {
    const soVerificador = new FakeLlmProvider({ id: 'br-verif', tasks: ['verificador'] });
    expect(routeRequest(base, [soVerificador])).toEqual({ allowed: false, reason: 'nenhuma_rota_elegivel' });
  });
});
