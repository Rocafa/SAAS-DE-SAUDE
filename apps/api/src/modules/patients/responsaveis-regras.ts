import type { GuardianKind } from '../../db/schema';
import { IDADE_MAIORIDADE } from '../finance/financeiro-regras';

/**
 * Regras puras dos responsáveis do paciente (PAC-01.2; LGPD art. 14; CC arts. 3º a 5º e 1.767).
 *
 * - Vigência [desde, ate): `ate` EXCLUSIVO; sem `ate`, sem fim.
 * - Informação clínica ao responsável: só com a marca no vínculo, vínculo vigente HOJE e paciente MENOR
 *   (menos de 18 anos, CC art. 5º) — salvo curatela, que sobrevive à maioridade (CC art. 1.767). Aos 18
 *   anos o acesso cai sozinho, sem job: a regra é aplicada na leitura, com a data de nascimento
 *   decifrada. Sem data de nascimento não se presume menoridade: fica negado (minimização).
 */

export const ROTULO_DO_TIPO: Readonly<Record<GuardianKind, string>> = {
  pai_mae: 'Pai/Mãe',
  tutor: 'Tutor(a)',
  curador: 'Curador(a)',
  representante: 'Representante legal',
};

export type MotivoInformacaoClinica =
  | 'permitida'
  | 'marca_desligada'
  | 'vinculo_nao_vigente'
  | 'paciente_maior_de_idade'
  | 'sem_data_de_nascimento';

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

/** Menor de idade na data; null quando não se sabe (sem data de nascimento). */
export function menorEm(nascimento: string | null, data: string): boolean | null {
  const idade = idadeEm(nascimento, data);
  return idade === null ? null : idade < IDADE_MAIORIDADE;
}

export function informacaoClinica(
  vinculo: Vigencia & { readonly tipo: GuardianKind; readonly recebeInformacaoClinica: boolean },
  nascimentoDoPaciente: string | null,
  hoje: string,
): { readonly permitida: boolean; readonly motivo: MotivoInformacaoClinica } {
  const negar = (motivo: MotivoInformacaoClinica) => ({ permitida: false, motivo });
  if (!vinculo.recebeInformacaoClinica) return negar('marca_desligada');
  if (!vigenteEm(vinculo, hoje)) return negar('vinculo_nao_vigente');
  if (vinculo.tipo === 'curador') return { permitida: true, motivo: 'permitida' };
  const menor = menorEm(nascimentoDoPaciente, hoje);
  if (menor === null) return negar('sem_data_de_nascimento');
  if (!menor) return negar('paciente_maior_de_idade');
  return { permitida: true, motivo: 'permitida' };
}

/**
 * Pendências do cadastro (para a tela): menor sem responsável vigente e menor sem pagador vigente
 * (este último vira `pagador_responsavel` no recibo e no Receita Saúde quando a cobrança não tem pagador).
 */
export function pendenciasDoCadastro(
  menor: boolean | null,
  vinculos: readonly (Vigencia & { readonly pagador: boolean })[],
  hoje: string,
): string[] {
  if (menor !== true) return [];
  const vigentes = vinculos.filter((v) => vigenteEm(v, hoje));
  const p: string[] = [];
  if (vigentes.length === 0) p.push('menor_sem_responsavel_vigente');
  if (!vigentes.some((v) => v.pagador)) p.push('menor_sem_pagador_vigente');
  return p;
}
