/**
 * Regras do prontuário e dos documentos (sem tela, testadas no Vitest).
 * Modelos de evolução por nicho, validação para assinar e texto de atestado/declaração.
 */
import type { Profissional } from './api/tipos';

export type Modelo = 'fisio' | 'to' | 'psicologia';

export interface CampoModelo {
  id: string;
  rotulo: string;
  ajuda: string;
  tipo: 'texto' | 'escala';
  obrigatorio: boolean;
}

export const MODELOS: Record<Modelo, { nome: string; campos: CampoModelo[] }> = {
  fisio: {
    nome: 'Evolução de fisioterapia',
    campos: [
      { id: 'queixa', rotulo: 'Como o paciente chegou hoje', ajuda: 'O que ele contou: dor, melhora, dificuldade.', tipo: 'texto', obrigatorio: true },
      { id: 'dor', rotulo: 'Dor hoje (0 a 10)', ajuda: '0 é sem dor; 10 é a pior dor que ele já sentiu.', tipo: 'escala', obrigatorio: false },
      { id: 'conduta', rotulo: 'O que foi feito na sessão', ajuda: 'Exercícios, técnicas, aparelhos, tempo.', tipo: 'texto', obrigatorio: true },
      { id: 'resposta', rotulo: 'Como o paciente respondeu', ajuda: 'Tolerou bem? Sentiu algo?', tipo: 'texto', obrigatorio: false },
      { id: 'plano', rotulo: 'Próximos passos', ajuda: 'O que fazer na próxima sessão e orientações para casa.', tipo: 'texto', obrigatorio: false },
    ],
  },
  to: {
    nome: 'Evolução de terapia ocupacional',
    campos: [
      { id: 'objetivo', rotulo: 'Objetivo da sessão', ajuda: 'O que se queria trabalhar hoje.', tipo: 'texto', obrigatorio: true },
      { id: 'atividades', rotulo: 'Atividades feitas', ajuda: 'Atividades e adaptações usadas.', tipo: 'texto', obrigatorio: true },
      { id: 'desempenho', rotulo: 'Desempenho do paciente', ajuda: 'Independência, ajuda necessária, comportamento.', tipo: 'texto', obrigatorio: false },
      { id: 'plano', rotulo: 'Próximos passos', ajuda: 'O que fazer na próxima sessão e orientações à família.', tipo: 'texto', obrigatorio: false },
    ],
  },
  psicologia: {
    nome: 'Registro de sessão de psicologia',
    campos: [
      { id: 'tema', rotulo: 'Tema principal da sessão', ajuda: 'Escreva só o necessário (Res. CFP 01/2009).', tipo: 'texto', obrigatorio: true },
      { id: 'intervencoes', rotulo: 'Intervenções', ajuda: 'Técnicas e encaminhamentos da sessão.', tipo: 'texto', obrigatorio: false },
      { id: 'evolucao', rotulo: 'Evolução', ajuda: 'Como o processo está andando.', tipo: 'texto', obrigatorio: true },
    ],
  },
};

export function modeloDoProfissional(p: Pick<Profissional, 'especialidade'> | undefined): Modelo {
  const e = (p?.especialidade ?? '').toLowerCase();
  if (e.includes('psico')) return 'psicologia';
  if (e.includes('ocupacional')) return 'to';
  return 'fisio';
}

/** Registro de psicologia vai em compartimento separado e marcado (sigilo profissional). */
export function ehRestrito(modelo: Modelo): boolean {
  return modelo === 'psicologia';
}

/** Lista o que falta para assinar, já dizendo o que fazer. */
export function faltasParaAssinar(modelo: Modelo, campos: Record<string, string>): string[] {
  return MODELOS[modelo].campos
    .filter((c) => c.obrigatorio && !(campos[c.id] ?? '').trim())
    .map((c) => `Falta preencher “${c.rotulo}”.`);
}

const EXTENSO = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze'];

export function diasPorExtenso(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error('Afastamento de 1 a 15 dias. Acima disso, siga o fluxo do INSS.');
  return `${n} (${EXTENSO[n]}) ${n === 1 ? 'dia' : 'dias'}`;
}

export interface DadosAtestado {
  paciente: string;
  profissional: string;
  registro: string;
  data: string;
  dias: number;
  /** CID só com autorização expressa do paciente (Res. CFM 1.658/2002, art. 5º). */
  cid?: string;
  autorizouCid: boolean;
}

export function textoAtestado(d: DadosAtestado): string {
  const cid = d.cid?.trim() && d.autorizouCid ? ` CID: ${d.cid.trim().toUpperCase()} (incluído com autorização do paciente).` : '';
  return `Atesto, para os devidos fins, que ${d.paciente} esteve sob meus cuidados em ${d.data} e precisa de afastamento de suas atividades por ${diasPorExtenso(d.dias)}.${cid}`;
}

export function textoDeclaracao(d: { paciente: string; data: string; inicio: string; fim: string }): string {
  return `Declaro, para os devidos fins, que ${d.paciente} compareceu a atendimento nesta clínica em ${d.data}, das ${d.inicio} às ${d.fim}.`;
}

export function validarCid(cid: string): string | null {
  if (!cid.trim()) return null;
  return /^[A-Z]\d{2}(\.\d{1,2})?$/i.test(cid.trim()) ? null : 'CID no formato letra e números, ex.: M54.5.';
}
