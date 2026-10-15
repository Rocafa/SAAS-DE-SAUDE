import { EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import {
  AI_CONSENT_STATES,
  PSYCH_COMPARTMENT_MODES,
  RECORD_TEMPLATES,
  type AiConsentState,
  type PsychCompartmentMode,
  type RecordTemplate,
} from '../../db/schema';
import { MAX_TEXTO_CLINICO, textoClinico } from './modelos';

/**
 * Entrada das rotas de prontuário. Conteúdo clínico SÓ no corpo: na URL (query) entram apenas
 * paginação (V1 do parecer PR #57). Erro diz o NOME do campo, nunca o valor.
 */

export const LIMITE_PADRAO_HISTORICO = 20;
export const LIMITE_MAXIMO_HISTORICO = 50;
const PAGINA_MAXIMA = 10_000;
/** Nota privada: mesmo teto do campo de evolução. */
export const MAX_NOTA = MAX_TEXTO_CLINICO;

export interface AberturaDeAtendimento {
  readonly agendamentoId: string;
  readonly modelo?: RecordTemplate;
  readonly consentimentoIa?: AiConsentState;
}

export interface SalvamentoDeRegistro {
  /** Conteúdo bruto: validado no serviço contra o modelo DO ATENDIMENTO. */
  readonly conteudo: unknown;
  /** Versão que o cliente editou (0 = primeira). Diferente da atual: 409 `versao_desatualizada`. */
  readonly versaoBase: number;
}

export interface Paginacao {
  readonly pagina: number;
  readonly limite: number;
}

export interface NovaNota {
  readonly texto: string;
  readonly atendimentoId?: string;
  readonly incluirNaExportacao: boolean;
}

export interface AlteracaoNota {
  readonly texto?: string;
  readonly incluirNaExportacao?: boolean;
}

function textoLongo(v: Validador, entrada: Readonly<Record<string, unknown>>, campo: string, obrigatorio: boolean): string | undefined {
  if (!v.tem(campo)) {
    if (obrigatorio) v.falhar(campo);
    return undefined;
  }
  const t = textoClinico(entrada[campo], MAX_NOTA);
  if (typeof t !== 'string') {
    v.falhar(campo);
    return undefined;
  }
  return t;
}

export function validarAbertura(corpo: unknown): AberturaDeAtendimento {
  const v = new Validador(exigirObjeto(corpo, ['agendamentoId', 'modelo', 'consentimentoIa']));
  const agendamentoId = v.uuid('agendamentoId', true);
  const modelo = v.umDe('modelo', RECORD_TEMPLATES, false);
  const consentimentoIa = v.umDe('consentimentoIa', AI_CONSENT_STATES, false);
  v.concluir();
  return { agendamentoId: agendamentoId as string, ...(modelo ? { modelo } : {}), ...(consentimentoIa ? { consentimentoIa } : {}) };
}

export function validarSalvamento(corpo: unknown): SalvamentoDeRegistro {
  const entrada = exigirObjeto(corpo, ['conteudo', 'versaoBase']);
  const v = new Validador(entrada);
  const versaoBase = v.inteiro('versaoBase', { min: 0, max: 100_000, obrigatorio: true });
  if (!v.tem('conteudo')) v.falhar('conteudo');
  v.concluir();
  return { conteudo: entrada.conteudo, versaoBase: versaoBase as number };
}

export function validarAdendo(corpo: unknown): string {
  const entrada = exigirObjeto(corpo, ['texto']);
  const v = new Validador(entrada);
  const texto = textoLongo(v, entrada, 'texto', true);
  v.concluir();
  return texto as string;
}

export function validarPaginacao(query: unknown): Paginacao {
  const entrada = query ?? {};
  if (typeof entrada === 'object' && entrada !== null && !Array.isArray(entrada)) {
    const extras = Object.keys(entrada).filter((k) => k !== 'pagina' && k !== 'limite');
    // Texto livre na URL vai para logs fora do nosso controle (V1): recusa com código próprio.
    if (extras.length > 0) throw new EntradaInvalidaError(['dado_na_url']);
  }
  const v = new Validador(exigirObjeto(entrada, ['pagina', 'limite']));
  const pagina = v.inteiroDeTexto('pagina', { min: 1, max: PAGINA_MAXIMA, padrao: 1 });
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO_HISTORICO, padrao: LIMITE_PADRAO_HISTORICO });
  v.concluir();
  return { pagina, limite };
}

export function validarQueryVaziaClinica(query: unknown): void {
  const entrada = query ?? {};
  if (typeof entrada === 'object' && entrada !== null && Object.keys(entrada).length > 0) {
    throw new EntradaInvalidaError(['dado_na_url']);
  }
}

export function validarCorpoVazioClinico(corpo: unknown): void {
  exigirObjeto(corpo ?? {}, []);
}

export function validarNovaNota(corpo: unknown): NovaNota {
  const entrada = exigirObjeto(corpo, ['texto', 'atendimentoId', 'incluirNaExportacao']);
  const v = new Validador(entrada);
  const texto = textoLongo(v, entrada, 'texto', true);
  const atendimentoId = v.uuid('atendimentoId', false);
  const incluir = v.booleano('incluirNaExportacao');
  v.concluir();
  return { texto: texto as string, incluirNaExportacao: incluir ?? false, ...(atendimentoId ? { atendimentoId } : {}) };
}

export function validarAlteracaoNota(corpo: unknown): AlteracaoNota {
  const entrada = exigirObjeto(corpo, ['texto', 'incluirNaExportacao']);
  const v = new Validador(entrada);
  const texto = textoLongo(v, entrada, 'texto', false);
  const incluir = v.booleano('incluirNaExportacao');
  if (texto === undefined && incluir === undefined) v.falhar('corpo');
  v.concluir();
  return { ...(texto !== undefined ? { texto } : {}), ...(incluir !== undefined ? { incluirNaExportacao: incluir } : {}) };
}

/**
 * Retenção legal do paciente (D1.4 e R12 do #63): marcar exige a REFERÊNCIA do processo ou ofício
 * (gravada cifrada; nunca na trilha). `ativa` continua aceito só como `true`: retirar é outra rota,
 * em duas etapas e por duas pessoas.
 */
export function validarRetencaoLegal(corpo: unknown): { referencia: string } {
  const v = new Validador(exigirObjeto(corpo, ['ativa', 'referencia']));
  const ativa = v.booleano('ativa');
  if (ativa === false) v.falhar('ativa');
  const referencia = v.texto('referencia', { min: 3, max: 300, obrigatorio: true });
  v.concluir();
  return { referencia };
}

/** 1ª etapa da retirada da retenção legal (R12): motivo obrigatório (gravado cifrado). */
export function validarPedidoDeRetirada(corpo: unknown): { motivo: string } {
  const v = new Validador(exigirObjeto(corpo, ['motivo']));
  const motivo = v.texto('motivo', { min: 10, max: 1000, obrigatorio: true });
  v.concluir();
  return { motivo };
}

/** Designação da custódia das lacradas (R2): profissionais por id. */
export function validarDesignacaoDeCustodia(corpo: unknown): { autorProfissionalId: string; substitutoProfissionalId: string } {
  const v = new Validador(exigirObjeto(corpo, ['autorProfissionalId', 'substitutoProfissionalId']));
  const autor = v.uuid('autorProfissionalId', true);
  const subst = v.uuid('substitutoProfissionalId', true);
  v.concluir();
  return { autorProfissionalId: autor as string, substitutoProfissionalId: subst as string };
}

/** Decisão da custódia sobre uma nota lacrada (R2). */
export function validarDecisaoDeCustodia(corpo: unknown): 'guarda_clinica' | 'descartar' {
  const v = new Validador(exigirObjeto(corpo, ['decisao']));
  const d = v.umDe('decisao', ['guarda_clinica', 'descartar'] as const, true);
  v.concluir();
  return d as 'guarda_clinica' | 'descartar';
}

/**
 * Troca do sigilo da psicologia. `restringirAnteriores` só existe no sentido mais protetor
 * (`restrito_ao_autor`); com `prontuario_unico` é 400: abrir registro antigo não é configuração.
 */
export function validarConfiguracao(corpo: unknown): { psicologia: PsychCompartmentMode; restringirAnteriores?: boolean } {
  const v = new Validador(exigirObjeto(corpo, ['psicologia', 'restringirAnteriores']));
  const modo = v.umDe('psicologia', PSYCH_COMPARTMENT_MODES, true) as PsychCompartmentMode;
  const restringir = v.booleano('restringirAnteriores');
  if (restringir === true && modo !== 'restrito_ao_autor') v.falhar('restringirAnteriores');
  v.concluir();
  return { psicologia: modo, ...(restringir !== undefined ? { restringirAnteriores: restringir } : {}) };
}
