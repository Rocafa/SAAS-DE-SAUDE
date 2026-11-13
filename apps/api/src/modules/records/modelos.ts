/**
 * Modelos de registro clínico por nicho (MVP: fisio, TO e psicologia). Estrutura flexível, mas
 * VALIDADA por schema: chave desconhecida, tipo errado, texto longo demais ou medida fora da faixa
 * dão 400 com o nome do campo (nunca o valor). Cada versão gravada guarda o modelo e a versão do
 * modelo (PRO-01.4): mudar um modelo não reinterpreta registros antigos.
 *
 * - fisio (v2, #167): queixa, avaliação, diagnóstico e prognóstico fisioterapêuticos (Res. COFFITO 414/2012, art. 1º
 *   §1º V), exames complementares realizados ou solicitados (inciso IV), conduta, resposta, orientações, próximos passos,
 *   medidas/escalas e plano de sessões com metas (HU-PRO-021/022).
 * - TO (v2, #167; Res. COFFITO 415/2012): modelo próprio, não mais os textos da fisioterapia. Objetivo da sessão,
 *   atividades e adaptações, desempenho, nível de assistência, próximos passos, além dos textos comuns.
 * - Escalas: instrumento conhecido pelo rótulo tem faixa própria (Barthel, MIF, Berg, NPRS); os demais, faixa larga.
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
  /**
   * Obrigatórios de versões ANTERIORES do modelo: o registro aberto numa versão é finalizado pela regra dela (PRO-01.4,
   * mudar o modelo não reinterpreta registro antigo).
   */
  readonly obrigatoriosAnteriores?: Readonly<Record<number, readonly string[]>>;
  readonly medidas: boolean;
  readonly plano: boolean;
}

/** Textos da versão 1 (fisio e TO compartilhavam). Continuam aceitos: a mudança é só aditiva. */
const TEXTOS_REABILITACAO = ['queixa', 'avaliacao', 'conduta', 'resposta', 'orientacoes'] as const;

export const MODELOS: Readonly<Record<RecordTemplate, DefinicaoModelo>> = {
  fisio: {
    nome: 'Evolução de fisioterapia',
    versao: 2,
    // #167: diagnóstico e prognóstico (COFFITO 414 art. 1º §1º V), exames complementares (IV) e os próximos passos
    // que a tela já pede (`plano`; texto, diferente do `planoDeSessoes`, que é o plano numérico com metas).
    textos: [...TEXTOS_REABILITACAO, 'diagnostico', 'exames', 'plano'],
    obrigatoriosParaFinalizar: ['queixa', 'conduta'],
    medidas: true,
    plano: true,
  },
  to: {
    nome: 'Evolução de terapia ocupacional',
    versao: 2,
    // #167: o que é da TO (COFFITO 415/2012) e a tela já pede: objetivo, atividades, desempenho, nível de assistência
    // e próximos passos. Os textos da v1 continuam aceitos.
    textos: [...TEXTOS_REABILITACAO, 'objetivo', 'atividades', 'desempenho', 'nivel_assistencia', 'plano'],
    obrigatoriosParaFinalizar: ['objetivo', 'atividades'],
    obrigatoriosAnteriores: { 1: ['queixa', 'conduta'] },
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

/**
 * Instrumentos conhecidos (pelo rótulo da medida `escala`): faixa e inteiro próprios, para o gráfico não mentir (#167).
 * Só instrumentos de uso livre. A COPM não entra (tem dono; licença no Brasil não confirmada). Psicologia não tem
 * medidas: instrumento psicológico é do SATEPSI e privativo do psicólogo (Res. CFP 31/2022).
 */
const INSTRUMENTOS: Readonly<Record<string, { min: number; max: number }>> = {
  barthel: { min: 0, max: 100 },
  mif: { min: 18, max: 126 },
  // C2 do parecer de 13/11: as subescalas da MIF têm faixa própria (13 itens motores e 5 cognitivos, de 1 a 7).
  mif_motora: { min: 13, max: 91 },
  mif_cognitiva: { min: 5, max: 35 },
  berg: { min: 0, max: 56 },
  nprs: { min: 0, max: 10 },
};

/**
 * Instrumento pelo rótulo: "Índice de Barthel", "MIF total", "MIF motora", "Escala de Berg" e "NPRS" casam pela palavra.
 * Casar pelo rótulo é provisório: o campo `instrumento` explícito é o próximo passo (parecer de 13/11).
 */
export function instrumentoDoRotulo(rotulo: string): keyof typeof INSTRUMENTOS | undefined {
  const palavras = rotulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (palavras.includes('mif')) {
    if (palavras.some((p) => p.startsWith('motor'))) return 'mif_motora';
    if (palavras.some((p) => p.startsWith('cognit'))) return 'mif_cognitiva';
  }
  return Object.keys(INSTRUMENTOS).find((i) => palavras.includes(i));
}

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
    if (tipo === 'escala' && rotulo) {
      const instrumento = instrumentoDoRotulo(rotulo);
      const propria = instrumento ? INSTRUMENTOS[instrumento] : undefined;
      if (propria && (v < propria.min || v > propria.max || !Number.isInteger(v))) {
        erros.push(`${campo}.valor`);
        return;
      }
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

/**
 * Campos obrigatórios ainda vazios (nomes, para o front orientar). Vazio = pode finalizar. `versaoModelo` é a da versão
 * do registro: registro da v1 segue a regra da v1.
 */
export function faltasParaFinalizar(modelo: RecordTemplate, conteudo: ConteudoRegistro, versaoModelo?: number): string[] {
  const def = MODELOS[modelo];
  const obrigatorios = versaoModelo !== undefined && versaoModelo !== def.versao ? (def.obrigatoriosAnteriores?.[versaoModelo] ?? def.obrigatoriosParaFinalizar) : def.obrigatoriosParaFinalizar;
  return obrigatorios.filter((c) => typeof conteudo[c] !== 'string');
}
