/**
 * Comando operacional da anonimização a pedido do titular (B10). Roda como tarefa avulsa do ECS, com definição e papel
 * de tarefa próprios, só com as credenciais de banco (R5 do parecer de 12/11/2026). Runbook:
 * docs/04-arquitetura/runbook-anonimizacao-pelo-suporte.md.
 *
 *   node dist/ops/anonimizar-conta.js --usuario <uuid> --chamado LGPD-<n> --operador <uuid>
 *   (com CONFIRMA_ANONIMIZACAO=<o mesmo uuid do usuário> no ambiente da tarefa)
 *
 * A saída (pelo Logger) é uma linha só: `ok <uuid> clinicas=<n> [repetida]` ou um código fixo. Nunca a mensagem ou a pilha do
 * driver, que podem trazer parâmetros da consulta (R4).
 */
import { Logger } from '@nestjs/common';
import { createDatabase } from '../db/tenant-transaction';
import { AnonimizacaoRecusada, anonimizarContaDoTitular, conferirAnonimizacao, type BancosDaAnonimizacao, type ResultadoDaAnonimizacao } from '../modules/auth/better-auth/anonimizacao';

export type CodigoDoComando = 'ok' | 'uso_incorreto' | 'trava_incorreta' | 'conferencia_falhou' | 'erro_inesperado' | AnonimizacaoRecusada['codigo'];

export interface DependenciasDoComando {
  readonly anonimizar: (pedido: { usuarioId: string; chamado: string; operador: string }) => Promise<ResultadoDaAnonimizacao>;
  readonly conferir: (usuarioId: string) => Promise<string[]>;
}

export interface SaidaDoComando {
  readonly codigo: CodigoDoComando;
  /** A única linha impressa. */
  readonly linha: string;
}

/** A saída vai pelo Logger, como o resto da API (CloudWatch, retenção do log de segurança). */
const saidaDoComando = new Logger('ops-anonimizacao');

const FLAGS = ['--usuario', '--chamado', '--operador'] as const;

function lerArgumentos(argv: readonly string[]): Record<(typeof FLAGS)[number], string> | null {
  const valores: Partial<Record<(typeof FLAGS)[number], string>> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as (typeof FLAGS)[number];
    const valor = argv[i + 1];
    if (!FLAGS.includes(flag) || valor === undefined || valores[flag] !== undefined) return null;
    valores[flag] = valor;
  }
  return FLAGS.every((f) => valores[f] !== undefined) ? (valores as Record<(typeof FLAGS)[number], string>) : null;
}

const falha = (codigo: CodigoDoComando): SaidaDoComando => ({ codigo, linha: codigo });

export async function executarComando(argv: readonly string[], env: NodeJS.ProcessEnv, deps: DependenciasDoComando): Promise<SaidaDoComando> {
  const args = lerArgumentos(argv);
  if (!args) return falha('uso_incorreto');
  // Trava contra erro de digitação: o uuid repetido no ambiente da tarefa. Recusa antes de qualquer escrita.
  if (env.CONFIRMA_ANONIMIZACAO !== args['--usuario']) return falha('trava_incorreta');
  let resultado: ResultadoDaAnonimizacao;
  try {
    resultado = await deps.anonimizar({ usuarioId: args['--usuario'], chamado: args['--chamado'], operador: args['--operador'] });
  } catch (err) {
    return falha(err instanceof AnonimizacaoRecusada ? err.codigo : 'erro_inesperado');
  }
  // Conferência DEPOIS, no banco (R4): só imprime ok se o estado é o de uma conta anonimizada.
  try {
    if ((await deps.conferir(args['--usuario'])).length > 0) return falha('conferencia_falhou');
  } catch {
    return falha('erro_inesperado');
  }
  return { codigo: 'ok', linha: `ok ${args['--usuario']} clinicas=${resultado.clinicas}${resultado.repetida ? ' repetida' : ''}` };
}

async function principal(): Promise<void> {
  const authUrl = process.env.DATABASE_AUTH_URL;
  const clinicaUrl = process.env.DATABASE_URL;
  if (!authUrl || !clinicaUrl) {
    saidaDoComando.log('uso_incorreto');
    process.exitCode = 2;
    return;
  }
  const dbAuth = createDatabase(authUrl, { max: 1 });
  const dbClinica = createDatabase(clinicaUrl, { max: 1 });
  const bancos: BancosDaAnonimizacao = { dbAuth: dbAuth.db, dbClinica: dbClinica.db };
  try {
    const saida = await executarComando(process.argv.slice(2), process.env, {
      anonimizar: (pedido) => anonimizarContaDoTitular(bancos, pedido),
      conferir: (usuarioId) => conferirAnonimizacao(bancos, usuarioId),
    });
    saidaDoComando.log(saida.linha);
    process.exitCode = saida.codigo === 'ok' ? 0 : 1;
  } finally {
    await Promise.allSettled([dbAuth.close(), dbClinica.close()]);
  }
}

if (require.main === module) {
  principal().catch(() => {
    saidaDoComando.log('erro_inesperado');
    process.exitCode = 1;
  });
}
