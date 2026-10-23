import type { TenantId } from '@plataforma/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { criarRegistroDeJobs, type ServicosDosJobs } from './registro-de-jobs';

const T = '00000000-0000-4000-8000-0000000000c1' as TenantId;

function servicos(chamadas: string[]): ServicosDosJobs {
  const marca = <R>(nome: string, r: R) => (...args: unknown[]) => (chamadas.push(`${nome}:${String(args[0] instanceof Array ? args[0][0] : args[0])}`), Promise.resolve(r));
  return {
    whatsapp: {
      executarLembretesComoSistema: marca('lembretes', { motivo: 'ok', programados: 1, semOptIn: 0, semDestinatario: 0, numeroMudou: 0, enviados: 1, falharam: 0, cancelados: 0 }),
      executarRetencaoComoSistema: marca('retencao', { agendadosExpirados: 0, enviosInterrompidos: 0, enviosLimpos: 2 }),
    } as unknown as ServicosDosJobs['whatsapp'],
    portal: { encerrarRepresentacoesDaClinica: marca('portal', { vinculosRevogados: 1, consentimentosEncerrados: 0 }) },
    importacao: { expurgoDiario: marca('importador', { clinicas: 1, arquivosDescartados: 0, atrasados: 0, alarme: false, clinicasComAtraso: [] }) },
    notas: { executarCicloComoSistema: marca('notas', { guardaClinica: 0, lacradas: 0, eliminadas: 0, suspensasPorRetencao: 0, expurgadas: 0 }) },
    retencaoFiscal: { executarComoSistema: marca('fiscal', { recibosEliminados: 0, cobrancasEliminadas: 0, pagadoresEliminados: 0, politica: { anos: 5 } }) } as unknown as ServicosDosJobs['retencaoFiscal'],
    responsaveis: { descartarAnuladosComoSistema: marca('responsaveis', { descartados: 0 }) },
  };
}

describe('registro central dos jobs', () => {
  it('cada job chama o serviço da clínica recebida e devolve só contagens/marcas', async () => {
    const chamadas: string[] = [];
    const jobs = criarRegistroDeJobs(servicos(chamadas));
    for (const j of jobs) {
      const r = await j.porClinica(T);
      for (const v of Object.values(r)) expect(['number', 'boolean']).toContain(typeof v);
    }
    expect(chamadas).toEqual(['lembretes', 'retencao', 'portal', 'importador', 'notas', 'fiscal', 'responsaveis'].map((n) => `${n}:${T}`));
  });

  it('a tabela do api-dominio §14 lista exatamente os jobs do registro, com a mesma periodicidade', () => {
    const doc = readFileSync(join(__dirname, '../../../../../docs/04-arquitetura/api-dominio.md'), 'utf8');
    const secao = doc.slice(doc.indexOf('## 14. Agendador de jobs'));
    const linhas = secao.split('\n').filter((l) => /^\| `[a-z-]+` \|/.test(l));
    const naTabela = linhas.map((l) => {
      const [, nome, periodicidade] = l.split('|').map((c) => c.trim());
      return { nome: nome?.replaceAll('`', ''), periodicidade };
    });
    const jobs = criarRegistroDeJobs(servicos([]));
    expect(naTabela).toEqual(jobs.map((j) => ({ nome: j.nome, periodicidade: j.periodicidade.descricao })));
  });

  it('todo job do registro é crítico (entra no sinal de vida)', () => {
    expect(criarRegistroDeJobs(servicos([])).filter((j) => !j.critico)).toEqual([]);
  });
});
