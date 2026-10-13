import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { criarApiFake } from './api/fake';
import { criarApiPortalFake } from './api/portal-fake';
import { CONSENTIMENTOS, DIREITOS, PRAZO_RESPOSTA_DIAS, permitido, prazoResposta, protocolo } from './portal';

const hoje = new Date(2026, 9, 12, 10);

describe('portal: regras', () => {
  it('"não respondido" vale como NÃO (ressalva R1 do Guardião)', () => {
    expect(permitido('sim')).toBe(true);
    expect(permitido('nao')).toBe(false);
    expect(permitido('nao_respondido')).toBe(false);
    expect(permitido(undefined)).toBe(false);
  });
  it('prazo de resposta e protocolo', () => {
    expect(PRAZO_RESPOSTA_DIAS).toBe(15);
    expect(prazoResposta('2026-10-12')).toBe('2026-10-27');
    expect(protocolo('2026-10-12', 7)).toBe('20261012-0007');
  });
  it('textos sem jargão jurídico nem técnico', () => {
    for (const t of [...DIREITOS.map((d) => d.titulo + d.explicacao), ...CONSENTIMENTOS.map((c) => c.titulo + c.explicacao)]) {
      expect(t).not.toMatch(/titular|controlador|tratamento de dados|tenant|registro de|submeter/i);
    }
  });
  it('apagar explica a guarda legal do prontuário', () => {
    expect(DIREITOS.find((d) => d.tipo === 'apagar')?.explicacao).toMatch(/prazo da lei/);
  });
});

describe('B3 do Guardião: portal com contrato próprio, sem dado de outros pacientes', () => {
  it('não mexe em consulta de outra pessoa (mesma resposta de "não existe")', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    await expect(api.confirmarPresenca('a07')).rejects.toThrow('Consulta não encontrada.');
    await expect(api.avisarAusencia('a01')).rejects.toThrow('Consulta não encontrada.');
    await expect(api.desfazerResposta('a07')).rejects.toThrow('Consulta não encontrada.');
  });

  it('só lista as consultas da própria sessão', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    const minhas = (await api.minhasConsultas()).map((c) => c.id).sort();
    const daMaria = (await criarApiFake({ agora: hoje }).listarAgendamentos({ pacienteId: 'p01', de: '2026-10-12' }))
      .filter((a) => ['agendado', 'confirmado', 'cancelado'].includes(a.status))
      .map((a) => a.id)
      .sort();
    expect(minhas).toEqual(daMaria);
    expect(minhas.length).toBeGreaterThan(0);
  });

  it('confirmar e desfazer a própria consulta', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    const c = (await api.minhasConsultas()).find((x) => x.status === 'agendado')!;
    await api.confirmarPresenca(c.id);
    expect((await api.minhasConsultas()).find((x) => x.id === c.id)?.status).toBe('confirmado');
    await api.desfazerResposta(c.id);
    expect((await api.minhasConsultas()).find((x) => x.id === c.id)?.status).toBe('agendado');
  });

  it('consentimento é histórico: desfazer grava evento novo e volta a "não respondido"', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    expect((await api.meusConsentimentos()).escriba_ia).toBe('nao_respondido');
    await api.responderConsentimento('escriba_ia', 'sim');
    expect((await api.meusConsentimentos()).escriba_ia).toBe('sim');
    await api.desfazerConsentimento('escriba_ia');
    expect((await api.meusConsentimentos()).escriba_ia).toBe('nao_respondido');
    expect((await api.historicoConsentimento('escriba_ia')).map((e) => e.resposta)).toEqual(['sim', 'desfeito']);
  });

  it('pedido gera protocolo e prazo; correção exige dizer o que está errado', async () => {
    const api = criarApiPortalFake({ agora: hoje });
    await expect(api.abrirPedido('corrigir', '  ')).rejects.toThrow(/o que está errado/);
    expect(await api.abrirPedido('baixar')).toMatchObject({ protocolo: '20261012-0001', prazo: '2026-10-27', situacao: 'aberto' });
    expect(await api.meusPedidos()).toHaveLength(1);
  });

  it('dados do titular vêm com CPF mascarado', async () => {
    expect((await criarApiPortalFake({ agora: hoje }).meusDados()).cpfMascarado).toMatch(/^\*\*\*\.\*\*\*\./);
  });

  it('as telas do portal não usam o provedor nem o contrato da clínica, e não passam pacienteId', () => {
    const raiz = new URL('..', import.meta.url).pathname;
    const arquivos = [
      ...readdirSync(join(raiz, 'app/(portal)'), { recursive: true }).map((f) => join(raiz, 'app/(portal)', String(f))),
      ...readdirSync(join(raiz, 'components/portal')).map((f) => join(raiz, 'components/portal', f)),
    ].filter((f) => /\.tsx?$/.test(f));
    expect(arquivos.length).toBeGreaterThan(4);
    for (const f of arquivos) {
      const codigo = readFileSync(f, 'utf8');
      expect(codigo, f).not.toMatch(/components\/app\/dados|lib\/api\/cliente|lib\/api\/fake['"]|pacienteId|ApiClinica/);
    }
    expect(readFileSync(join(raiz, 'lib/api/portal.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/pacienteId/);
  });
});
