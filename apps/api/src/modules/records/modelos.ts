/**
 * Modelos de registro clínico por nicho (MVP: fisio, TO e psicologia). Estrutura flexível, mas
 * VALIDADA por schema: chave desconhecida, tipo errado, texto longo demais ou medida fora da faixa
 * dão 400 com o nome do campo (nunca o valor). Cada versão gravada guarda o modelo e a versão do
 * modelo (PRO-01.4): mudar um modelo não reinterpreta registros antigos.
 *
 * - fisio/TO: queixa, avaliação, conduta, resposta, orientações, medidas/escalas (EVA, goniometria,
 *   força, perimetria, escala de domínio público pelo nome) e plano de sessões com metas (HU-PRO-021/022).
 * - psicologia: registro de sessão (tema, intervenções, evolução, encaminhamentos) e plano de sessões.
 *   As ANOTAÇÕES PRIVADAS do psicólogo não são registro: ficam em `private_notes` (notas-privadas.service.ts).
 */
import { EntradaInvalidaError } from '../../common/validacao';
import type { RecordTemplate } from '../../db/schema';

export const TIPOS_DE_MEDIDA = ['eva', 'goniometria', 'forca', 'perimetria', 'escala'] as const;
export type TipoDeMedida = (typeof TIPOS_DE_MEDIDA)[number];

export interface Medida {
  readonly tipo: TipoDeMedida;
  /** Ex.: "flexão de joelho D", "Escala de Berg". Obrigatório para goniometria, perimetria e escala. */
  readonly rotulo?: string;
  readonly valor: number;
}

export interface MetaDoPlano {
  readonly descricao: string;
  /** Progresso da meta, 0 a 100 (%). */
  readonly progresso?: number;
}

export interface PlanoDeSessoes {
  readonly totalSessoes: number;
  readonly frequenciaSemanal?: number;
  readonly metas: readonly MetaDoPlano[];
}

/** Conteúdo normalizado de um registro: textos do modelo + medidas e plano (quando o modelo aceita). */
export interface ConteudoRegistro {
  readonly [campo: string]: string | readonly Medida[] | PlanoDeSessoes | undefined;
}

interface DefinicaoModelo {
  readonly nome: string;
  readonly versao: number;
  readonly textos: readonly string[];
  readonly obrigatoriosParaFinalizar: readonly string[];
  readonly medidas: boolean;
  readonly plano: boolean;
}

const TEXTOS_REABILITACAO = ['queixa', 'avaliacao', 'conduta', 'resposta', 'orientacoes'] as const;

export const MODELOS: Readonly<Record<RecordTemplate, DefinicaoModelo>> = {
  fisio: {
    nome: 'Evolução de fisioterapia',
    versao: 1,
    textos: TEXTOS_REABILITACAO,
    obrigatoriosParaFinalizar: ['queixa', 'conduta'],
    medidas: true,
    plano: true,
  },
  to: {
    nome: 'Evolução de terapia ocupacional',
    versao: 1,
    textos: TEXTOS_REABILITACAO,
    obrigatoriosParaFinalizar: ['queixa', 'conduta'],
    medidas: true,
    plano: true,
  },
  psicologia: {
    nome: 'Registro de sessão de psicologia',
    versao: 1,
    textos: ['tema', 'intervencoes', 'evolucao', 'encaminhamentos'],
    obrigatoriosParaFinalizar: ['tema', 'evolucao'],
    medidas: false,
    plano: true,
  },
};

/** Limites (anti-abuso; um campo de evolução real cabe com folga). */
export const MAX_TEXTO_CLINICO = 20_000;
export const MAX_MEDIDAS = 50;
export const MAX_METAS = 20;
const MAX_ROTULO = 80;
const MAX_META = 300;

/** Faixa de valor por tipo de medida. EVA 0–10 inteiro; força: escala MRC 0–5. */
const FAIXAS: Readonly<Record<TipoDeMedida, { min: number; max: number; inteiro: boolean; rotulo: boolean }>> = {
  eva: { min: 0, max: 10, inteiro: true, rotulo: false },
  goniometria: { min: 0, max: 360, inteiro: false, rotulo: true },
  forca: { min: 0, max: 5, inteiro: true, rotulo: true },
  perimetria: { min: 0, max: 300, inteiro: false, rotulo: true },
  escala: { min: -1000, max: 10_000, inteiro: false, rotulo: true },
};

/** Modelo padrão pela especialidade do profissional (o front faz igual). */
export function modeloPelaEspecialidade(especialidade: string): RecordTemplate {
  const e = especialidade.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (e.includes('psico')) return 'psicologia';
  if (e.includes('ocupacional') || /\bto\b/.test(e)) return 'to';
  return 'fisio';
}

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Texto clínico: aceita quebra de linha e tabulação (evolução tem parágrafos); recusa os demais
 * caracteres de controle. Vazio vira "ausente".
 */
export function textoClinico(v: unknown, max: number): string | undefined | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (t.length === 0) return undefined;
  if (t.length > max) return null;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x0a || c === 0x09) continue;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return null;
  }
  return t;
}

/** Texto de uma linha (rótulo de medida, meta). */
function textoCurto(v: unknown, max: number): string | null {
  const t = textoClinico(v, max);
  if (typeof t !== 'string' || t.includes('\n') || t.includes('\t')) return null;
  return t;
}

function validarMedidas(valor: unknown, erros: string[]): Medida[] | undefined {
  if (!Array.isArray(valor) || valor.length > MAX_MEDIDAS) {
    erros.push('conteudo.medidas');
    return undefined;
  }
  const out: Medida[] = [];
  valor.forEach((m: unknown, i) => {
    const campo = `conteudo.medidas.${i}`;
    if (!ehObjetoSimples(m) || Object.keys(m).some((k) => !['tipo', 'rotulo', 'valor'].includes(k))) {
      erros.push(campo);
      return;
    }
    const tipo = m.tipo;
    if (typeof tipo !== 'string' || !(TIPOS_DE_MEDIDA as readonly string[]).includes(tipo)) {
      erros.push(`${campo}.tipo`);
      return;
    }
    const faixa = FAIXAS[tipo as TipoDeMedida];
    const v = m.valor;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < faixa.min || v > faixa.max || (faixa.inteiro && !Number.isInteger(v))) {
      erros.push(`${campo}.valor`);
      return;
    }
    let rotulo: string | undefined;
    if (m.rotulo !== undefined) {
      const r = textoCurto(m.rotulo, MAX_ROTULO);
      if (r === null) {
        erros.push(`${campo}.rotulo`);
        return;
      }
      rotulo = r;
    }
    if (faixa.rotulo && !rotulo && tipo !== 'forca') {
      erros.push(`${campo}.rotulo`);
      return;
    }
    out.push({ tipo: tipo as TipoDeMedida, valor: v, ...(rotulo ? { rotulo } : {}) });
  });
  return out;
}

function validarPlano(valor: unknown, erros: string[]): PlanoDeSessoes | undefined {
  if (!ehObjetoSimples(valor) || Object.keys(valor).some((k) => !['totalSessoes', 'frequenciaSemanal', 'metas'].includes(k))) {
    erros.push('conteudo.planoDeSessoes');
    return undefined;
  }
  const total = valor.totalSessoes;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > 200) erros.push('conteudo.planoDeSessoes.totalSessoes');
  const freq = valor.frequenciaSemanal;
  if (freq !== undefined && (typeof freq !== 'number' || !Number.isInteger(freq) || freq < 1 || freq > 7)) {
    erros.push('conteudo.planoDeSessoes.frequenciaSemanal');
  }
  const metasEntrada = valor.metas ?? [];
  const metas: MetaDoPlano[] = [];
  if (!Array.isArray(metasEntrada) || metasEntrada.length > MAX_METAS) {
    erros.push('conteudo.planoDeSessoes.metas');
  } else {
    metasEntrada.forEach((m: unknown, i) => {
      const campo = `conteudo.planoDeSessoes.metas.${i}`;
      if (!ehObjetoSimples(m) || Object.keys(m).some((k) => !['descricao', 'progresso'].includes(k))) {
        erros.push(campo);
        return;
      }
      const descricao = textoCurto(m.descricao, MAX_META);
      if (!descricao) {
        erros.push(`${campo}.descricao`);
        return;
      }
      const p = m.progresso;
      if (p !== undefined && (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100)) {
        erros.push(`${campo}.progresso`);
        return;
      }
      metas.push({ descricao, ...(p !== undefined ? { progresso: p } : {}) });
    });
  }
  if (typeof total !== 'number') return undefined;
  return { totalSessoes: total, ...(typeof freq === 'number' ? { frequenciaSemanal: freq } : {}), metas };
}

/**
 * Valida e normaliza o conteúdo de um registro no modelo dado. Rascunho pode estar incompleto (a
 * completude é cobrada na finalização, `faltasParaFinalizar`).
 */
export function validarConteudo(modelo: RecordTemplate, valor: unknown): ConteudoRegistro {
  const def = MODELOS[modelo];
  if (!ehObjetoSimples(valor)) throw new EntradaInvalidaError(['conteudo']);
  const permitidas = [...def.textos, ...(def.medidas ? ['medidas'] : []), ...(def.plano ? ['planoDeSessoes'] : [])];
  if (Object.keys(valor).some((k) => !permitidas.includes(k))) throw new EntradaInvalidaError(['campo_desconhecido']);
  const erros: string[] = [];
  const out: Record<string, string | readonly Medida[] | PlanoDeSessoes> = {};
  for (const campo of def.textos) {
    if (valor[campo] === undefined || valor[campo] === null) continue;
    const t = textoClinico(valor[campo], MAX_TEXTO_CLINICO);
    if (t === null) erros.push(`conteudo.${campo}`);
    else if (t !== undefined) out[campo] = t;
  }
  if (def.medidas && valor.medidas !== undefined) {
    const m = validarMedidas(valor.medidas, erros);
    if (m && m.length > 0) out.medidas = m;
  }
  if (def.plano && valor.planoDeSessoes !== undefined && valor.planoDeSessoes !== null) {
    const p = validarPlano(valor.planoDeSessoes, erros);
    if (p) out.planoDeSessoes = p;
  }
  if (erros.length > 0) throw new EntradaInvalidaError(erros);
  return out;
}

/** Campos obrigatórios ainda vazios (nomes, para o front orientar). Vazio = pode finalizar. */
export function faltasParaFinalizar(modelo: RecordTemplate, conteudo: ConteudoRegistro): string[] {
  return MODELOS[modelo].obrigatoriosParaFinalizar.filter((c) => typeof conteudo[c] !== 'string');
}
