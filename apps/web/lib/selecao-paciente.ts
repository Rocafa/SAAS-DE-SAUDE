/**
 * Escolha do paciente em formulários (marcar consulta). Condição F-1 do Guardião: no modo http a
 * escolha usa a busca do servidor (`buscarPacientes`, auditada sem o termo), nunca a lista completa,
 * que pode parar no teto de 1.000 e esconder quem existe (risco de cadastro duplicado).
 * Sem `buscarPacientes` (fake), a tela procura na lista local e repassa o `truncado` dela.
 */
import { acharPacientes } from './ajudante/busca';
import type { ApiClinica } from './api/cliente';
import type { ListaPacientes, Paciente } from './api/tipos';

/** Mesmo termo mínimo e mesma espera da tela de Pacientes. */
export const TERMO_MINIMO = 2;
export const ATRASO_BUSCA_MS = 350;
export const LIMITE_SUGESTOES = 6;

/** Busca no servidor quando dá; `null` quando o termo é curto ou o adaptador não busca (fake). */
export async function buscarParaEscolha(api: ApiClinica, termo: string): Promise<ListaPacientes | null> {
  const t = termo.trim();
  if (!api.buscarPacientes || t.length < TERMO_MINIMO) return null;
  return api.buscarPacientes(t);
}

export interface Sugestoes {
  itens: Paciente[];
  /** Mais nomes batem do que cabem na lista: a tela pede para continuar digitando. */
  haMais: boolean;
  /** A lista de origem parou no teto: a tela mostra o `AvisoTruncado`. */
  truncado: boolean;
}

export function sugestoesParaEscolha(e: { termo: string; doServidor: ListaPacientes | null; local: ListaPacientes }): Sugestoes {
  const termo = e.termo.trim();
  if (!termo) return { itens: [], haMais: false, truncado: false };
  const origem = e.doServidor ?? e.local;
  const ativos = origem.filter((p) => p.ativo);
  const achados = e.doServidor ? ativos : acharPacientes(termo, ativos).map((x) => x.paciente);
  return { itens: achados.slice(0, LIMITE_SUGESTOES), haMais: achados.length > LIMITE_SUGESTOES, truncado: Boolean(origem.truncado) };
}
