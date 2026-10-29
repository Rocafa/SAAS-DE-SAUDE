import type { GuardianKind } from '../../db/schema';
import { IDADE_MAIORIDADE } from '../finance/financeiro-regras';

/**
 * Regras puras dos responsáveis do paciente (PAC-01.2; LGPD art. 14; CC arts. 3º a 5º e 1.767; ECA art. 2º;
 * CEM art. 74; CFP art. 13; parecer do Guardião sobre o PR #67).
 *
 * - Vigência [desde, ate): `ate` EXCLUSIVO; sem `ate`, sem fim.
 * - Informação clínica ao responsável: NUNCA automática. Exige a marca no vínculo, ligada por DECISÃO do
 *   profissional (perfil clínico + vínculo de cuidado, com justificativa cifrada; o banco grava autor e
 *   data), vínculo vigente HOJE e paciente MENOR não emancipado — salvo curatela, que também depende da
 *   decisão do profissional (a curatela não alcança o direito à saúde por si, Lei 13.146/2015 art. 85).
 * - Faixas (REGRA_INFORMACAO_CLINICA, configurável aqui e documentada em api-dominio.md §11):
 *   criança (até `idadeInicioAdolescencia - 1`, padrão 11 anos): vale a decisão do profissional;
 *   adolescente (de `idadeInicioAdolescencia`, padrão 12, até 17): o profissional decide CASO A CASO
 *   (capacidade de discernimento, CEM art. 74; só o estritamente essencial, CFP art. 13). Padrão
 *   PROTETOR: decisão tomada antes dos 12 anos NÃO vale na adolescência — a marca deixa de produzir efeito
 *   no aniversário de 12 anos até nova decisão (pendência `revisar_informacao_clinica_adolescente`).
 * - Aos 18 anos (ou na emancipação) o acesso cai sozinho, sem job: a regra é aplicada na leitura, com a
 *   data de nascimento decifrada. Sem data de nascimento não se presume menoridade: fica negado.
 */

export interface RegraInformacaoClinica {
  /** ECA art. 2º: adolescente a partir dos 12 anos completos. */
  readonly idadeInicioAdolescencia: number;
  /** false (padrão protetor): adolescente só compartilha com decisão do profissional tomada já na adolescência. */
  readonly adolescenteCompartilhaComDecisaoAnterior: boolean;
}

export const REGRA_INFORMACAO_CLINICA: RegraInformacaoClinica = {
  idadeInicioAdolescencia: 12,
  adolescenteCompartilhaComDecisaoAnterior: false,
};

export const ROTULO_DO_TIPO: Readonly<Record<GuardianKind, string>> = {
  pai_mae: 'Pai/Mãe',
  tutor: 'Tutor(a)',
  curador: 'Curador(a)',
  representante: 'Representante legal',
  apoiador: 'Apoiador(a) (decisão apoiada)',
};

/**
 * Decisão apoiada (CC art. 1.783-A; 0055): o apoiador NÃO representa. O paciente é maior e capaz e decide em
 * nome próprio. O apoiador não age pelo paciente no portal nem recebe lembrete por ele, e a informação clínica
 * só chega a ele com a autorização expressa do paciente e a decisão do profissional.
 */
export function tipoRepresentaPaciente(tipo: GuardianKind): boolean {
  return tipo !== 'apoiador';
}

export type MotivoInformacaoClinica =
  | 'permitida'
  | 'marca_desligada'
  | 'vinculo_nao_vigente'
  | 'sem_decisao_do_profissional'
  | 'adolescente_requer_nova_decisao'
  | 'paciente_maior_de_idade'
  | 'paciente_emancipado'
  | 'sem_autorizacao_do_paciente'
  | 'sem_data_de_nascimento';

export type FaixaEtaria = 'crianca' | 'adolescente' | 'adulto';

export interface Vigencia {
  readonly desde: string;
  readonly ate: string | null;
}

/** Vigente na data (AAAA-MM-DD): desde <= data < ate. */
export function vigenteEm(v: Vigencia, data: string): boolean {
  return v.desde <= data && (v.ate === null || data < v.ate);
}

/** Idade completa na data; null sem data de nascimento válida. */
export function idadeEm(nascimento: string | null, data: string): number | null {
  if (!nascimento || !/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return null;
  const [an, mn, dn] = nascimento.split('-').map(Number) as [number, number, number];
  const [ad, md, dd] = data.split('-').map(Number) as [number, number, number];
  return ad - an - (md < mn || (md === mn && dd < dn) ? 1 : 0);
}

/** Data (AAAA-MM-DD) em que completa `anos` (29/02 vira 01/03 em ano não bissexto). */
export function aniversarioDe(nascimento: string, anos: number): string {
  const [a, m, d] = nascimento.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(a + anos, m - 1, d)).toISOString().slice(0, 10);
}

/** Menor de idade na data; null quando não se sabe (sem data de nascimento). Emancipado = maior. */
export function menorEm(nascimento: string | null, data: string, emancipadoEm: string | null = null): boolean | null {
  if (emancipadoEm !== null && emancipadoEm <= data) return false;
  const idade = idadeEm(nascimento, data);
  return idade === null ? null : idade < IDADE_MAIORIDADE;
}

export function faixaEtariaEm(
  nascimento: string | null,
  data: string,
  emancipadoEm: string | null = null,
  regra: RegraInformacaoClinica = REGRA_INFORMACAO_CLINICA,
): FaixaEtaria | null {
  const menor = menorEm(nascimento, data, emancipadoEm);
  if (menor === null) return null;
  if (!menor) return 'adulto';
  return (idadeEm(nascimento, data) ?? 0) >= regra.idadeInicioAdolescencia ? 'adolescente' : 'crianca';
}

export interface VinculoParaInformacaoClinica extends Vigencia {
  readonly tipo: GuardianKind;
  readonly recebeInformacaoClinica: boolean;
  /** Data (AAAA-MM-DD, fuso da clínica) da decisão do profissional; null sem decisão. */
  readonly decididaEm: string | null;
  /** Apoiador (0055, B1): autorização expressa do paciente registrada. Os outros tipos ignoram. */
  readonly autorizadoPeloPaciente?: boolean;
}

export function informacaoClinica(
  vinculo: VinculoParaInformacaoClinica,
  nascimentoDoPaciente: string | null,
  hoje: string,
  emancipadoEm: string | null = null,
  regra: RegraInformacaoClinica = REGRA_INFORMACAO_CLINICA,
): { readonly permitida: boolean; readonly motivo: MotivoInformacaoClinica } {
  const negar = (motivo: MotivoInformacaoClinica) => ({ permitida: false, motivo });
  if (!vinculo.recebeInformacaoClinica) return negar('marca_desligada');
  if (!vigenteEm(vinculo, hoje)) return negar('vinculo_nao_vigente');
  if (vinculo.decididaEm === null) return negar('sem_decisao_do_profissional');
  if (vinculo.tipo === 'curador') return { permitida: true, motivo: 'permitida' };
  // Decisão apoiada (B1 do parecer de 29/10): o apoiado é capaz; além da decisão do profissional, exige a
  // autorização expressa do paciente (CEM art. 73, LGPD art. 11, I). Sem regra de idade.
  if (vinculo.tipo === 'apoiador') return vinculo.autorizadoPeloPaciente === true ? { permitida: true, motivo: 'permitida' } : negar('sem_autorizacao_do_paciente');
  const menor = menorEm(nascimentoDoPaciente, hoje, emancipadoEm);
  if (menor === null) return negar('sem_data_de_nascimento');
  if (!menor) return negar(emancipadoEm !== null && emancipadoEm <= hoje ? 'paciente_emancipado' : 'paciente_maior_de_idade');
  const idade = idadeEm(nascimentoDoPaciente, hoje) ?? 0;
  if (idade >= regra.idadeInicioAdolescencia && !regra.adolescenteCompartilhaComDecisaoAnterior) {
    const inicio = aniversarioDe(nascimentoDoPaciente as string, regra.idadeInicioAdolescencia);
    if (vinculo.decididaEm < inicio) return negar('adolescente_requer_nova_decisao');
  }
  return { permitida: true, motivo: 'permitida' };
}

/**
 * Pendências do cadastro (para a tela): menor sem responsável vigente, menor sem pagador vigente (vira
 * `pagador_responsavel` no recibo quando o recebimento não congela pagador) e marca clínica de adolescente
 * à espera de nova decisão do profissional.
 */
export function pendenciasDoCadastro(
  menor: boolean | null,
  vinculos: readonly (Vigencia & { readonly pagador: boolean; readonly motivoInformacaoClinica?: MotivoInformacaoClinica })[],
  hoje: string,
): string[] {
  if (menor !== true) return [];
  const vigentes = vinculos.filter((v) => vigenteEm(v, hoje));
  const p: string[] = [];
  if (vigentes.length === 0) p.push('menor_sem_responsavel_vigente');
  if (!vigentes.some((v) => v.pagador)) p.push('menor_sem_pagador_vigente');
  if (vigentes.some((v) => v.motivoInformacaoClinica === 'adolescente_requer_nova_decisao')) p.push('revisar_informacao_clinica_adolescente');
  return p;
}
