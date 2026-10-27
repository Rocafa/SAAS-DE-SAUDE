/**
 * Escolha do adaptador por variável de ambiente (lida no build do Next):
 * - `NEXT_PUBLIC_API_MODO=fake` (padrão): tudo no fake em memória, como antes.
 * - `NEXT_PUBLIC_API_MODO=http`: pacientes e agenda na API real (`NEXT_PUBLIC_API_ORIGIN`, a mesma
 *   origem liberada no `connect-src` da CSP); atendimento, financeiro, espera, recibos etc.
 *   continuam no fake até ganharem rota.
 * Nenhuma das duas variáveis é segredo.
 */
import type { ApiClinica } from './cliente';
import { criarApiFake, type OpcoesFake } from './fake';
import { criarApiHttp, type OpcoesHttp } from './http';
import type { Paciente } from './tipos';

export type ModoApi = 'fake' | 'http';

export interface ConfigApi {
  modo: ModoApi;
  origem?: string;
}

/** Valida igual a `origemDaApi` do next.config.ts (modo http exige origem; produção só https). */
export function lerConfigApi(
  env: { NEXT_PUBLIC_API_MODO?: string | undefined; NEXT_PUBLIC_API_ORIGIN?: string | undefined; NODE_ENV?: string | undefined } = {
    // Acesso literal: o Next só embute NEXT_PUBLIC_* escritos assim.
    NEXT_PUBLIC_API_MODO: process.env.NEXT_PUBLIC_API_MODO,
    NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
    NODE_ENV: process.env.NODE_ENV,
  },
): ConfigApi {
  const modo = env.NEXT_PUBLIC_API_MODO?.trim() || 'fake';
  if (modo !== 'fake' && modo !== 'http') throw new Error('NEXT_PUBLIC_API_MODO inválido: use fake ou http');
  if (modo === 'fake') return { modo };
  const origem = env.NEXT_PUBLIC_API_ORIGIN?.trim().toLowerCase();
  if (!origem || !/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origem)) {
    throw new Error('NEXT_PUBLIC_API_ORIGIN obrigatória e válida com NEXT_PUBLIC_API_MODO=http');
  }
  if (env.NODE_ENV === 'production' && !origem.startsWith('https://')) throw new Error('NEXT_PUBLIC_API_ORIGIN: em produção só https');
  return { modo, origem };
}

/**
 * Projeção mínima do retrato em memória (ressalva R1a do parecer front-r8): id, nome, nome social,
 * telefone, 4 últimos dígitos do CPF e situação. Nascimento e responsáveis não entram.
 */
export function paraIndice(p: Paciente): Paciente {
  const r: Paciente = {
    id: p.id,
    nome: p.nome,
    telefone: p.telefone,
    cpf: p.cpf.replace(/\D/g, '').slice(-4),
    nascimento: '',
    responsaveis: [],
    ativo: p.ativo,
    ficticio: true,
  };
  if (p.nomeSocial) r.nomeSocial = p.nomeSocial;
  return r;
}

export function criarApi(
  config: ConfigApi,
  opcoes: { fake?: OpcoesFake; http?: Omit<OpcoesHttp, 'baseUrl'> } = {},
): ApiClinica {
  const fake = criarApiFake(opcoes.fake ?? {});
  if (config.modo === 'fake' || !config.origem) return fake;
  return { ...fake, ...criarApiHttp({ ...opcoes.http, baseUrl: config.origem }) };
}
