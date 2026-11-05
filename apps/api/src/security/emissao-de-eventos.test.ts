/**
 * R8 do parecer do #129 (e R3 do #136): cada módulo grava o evento certo no log de segurança, sem dado pessoal.
 * Webhook, vigilância de leitura (equipe), vigilância do portal e exportação, com dependências falsas e sem banco.
 */
import { Logger } from '@nestjs/common';
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappWebhookController } from '../modules/messaging/whatsapp.controller';
import { VIGILANCIA_PADRAO, VigilanciaDeLeituraService } from '../modules/patients/vigilancia-de-leitura';
import { PortalController } from '../modules/portal/portal.controller';
import { PortalVigilanciaService } from '../modules/portal/portal-vigilancia';
import { ExportsService } from '../modules/exports/exports.module';
import { protecaoCsrf, rateLimiter } from './http-security';
import { origemDaRequisicao, zerarJanelasDoLog } from './log-de-seguranca';
import { MemoryRateLimitStore, type RateLimitStore } from './rate-limit-store';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx: RequestContext = { tenantId: TENANT as TenantId, userId: USER as UserId, roles: ['recepcao'] };
const segredo = Buffer.alloc(32, 9);
const bancoFora = { run: () => Promise.reject(new Error('banco fora')), runPortal: () => Promise.reject(new Error('banco fora')) };

/** Linhas JSON do log de segurança capturadas em warn e error. */
function capturar(): { eventos: () => Record<string, unknown>[]; tudo: () => string } {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const linhas = () => [...warn.mock.calls, ...error.mock.calls].map((c) => String(c[0]));
  return {
    eventos: () => linhas().filter((l) => l.startsWith('{"tipo":"seguranca"')).map((l) => JSON.parse(l) as Record<string, unknown>),
    tudo: () => linhas().join('\n'),
  };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => zerarJanelasDoLog()); // R3 do parecer do #138: sem depender da ordem dos testes

describe('webhook do WhatsApp', () => {
  it('assinatura inválida: WEBHOOK_ASSINATURA_INVALIDA com a origem em HMAC, nunca o IP', async () => {
    const log = capturar();
    const controller = new WhatsappWebhookController({ adaptador: { assinaturaValida: () => false } } as never);
    // R4 do parecer do #138: 401, e a origem é a do IP da requisição.
    await expect(controller.receber({ rawBody: Buffer.from('{}'), ip: '203.0.113.9', headers: {} } as never, 'sha256=forjada')).rejects.toMatchObject({ status: 401 });
    const [e] = log.eventos().filter((x) => x['evento'] === 'WEBHOOK_ASSINATURA_INVALIDA');
    expect(e).toMatchObject({ motivo: 'whatsapp', severidade: 'alto' });
    expect(e?.['origem']).toBe(origemDaRequisicao('203.0.113.9'));
    expect(log.tudo()).not.toContain('203.0.113.9');
  });
});

describe('vigilância de leitura (equipe)', () => {
  const config = { ...VIGILANCIA_PADRAO, listaMax: 1000, anomaliaPaginas: 2 };

  it('padrão de páginas: ALERTA_ANOMALIA com a regra; banco fora: TRILHA_NAO_GRAVADA (o alerta não some)', async () => {
    const log = capturar();
    const v = new VigilanciaDeLeituraService(bancoFora as never, new MemoryRateLimitStore(), { config, hashKey: segredo, fecharStore: false });
    for (let i = 0; i < 3; i++) await v.listagem(ctx);
    const eventos = log.eventos();
    expect(eventos.filter((e) => e['evento'] === 'ALERTA_ANOMALIA')).toEqual([expect.objectContaining({ regra: 'paginas_de_pacientes' })]);
    expect(eventos.some((e) => e['evento'] === 'TRILHA_NAO_GRAVADA' && e['regra'] === 'paginas_de_pacientes')).toBe(true);
  });

  it('contador fora do ar: RATE_LIMIT_FAIL_OPEN no máximo uma vez por minuto, mesmo com várias leituras', async () => {
    const log = capturar();
    const quebrado: RateLimitStore = { hit: () => Promise.reject(new Error('redis fora')) } as never;
    const v = new VigilanciaDeLeituraService(bancoFora as never, quebrado, { config, hashKey: segredo, fecharStore: false });
    for (let i = 0; i < 5; i++) await v.listagem(ctx);
    expect(log.eventos().filter((e) => e['evento'] === 'RATE_LIMIT_FAIL_OPEN' && e['motivo'] === 'vigilancia_de_leitura')).toHaveLength(1);
  });
});

describe('vigilância do portal', () => {
  it('resgate insistente: um ALERTA_ANOMALIA portal_resgate e 429; nada da conta no log', async () => {
    const log = capturar();
    const conta = '33333333-3333-4333-8333-333333333333';
    const v = new PortalVigilanciaService(bancoFora as never, new MemoryRateLimitStore(), { config: VIGILANCIA_PADRAO, hashKey: segredo, fecharStore: false }, {
      contaMax: 1000,
      contaJanelaMs: 60_000,
      resgateMax: 2,
      resgateJanelaMs: 60_000,
    });
    await v.resgate(conta);
    await v.resgate(conta);
    await expect(v.resgate(conta)).rejects.toMatchObject({ status: 429 });
    await expect(v.resgate(conta)).rejects.toMatchObject({ status: 429 });
    expect(log.eventos().filter((e) => e['evento'] === 'ALERTA_ANOMALIA')).toEqual([expect.objectContaining({ regra: 'portal_resgate' })]);
    expect(log.tudo()).not.toContain(conta);
  });
});

describe('borda HTTP (R1 do parecer do #138)', () => {
  const resposta = (): ServerResponse & { statusCode: number } => ({ statusCode: 200, setHeader: () => undefined, end: () => undefined }) as never;

  it('contador do rate limit fora: a requisição segue e sai UM RATE_LIMIT_FAIL_OPEN', async () => {
    const log = capturar();
    const quebrado: RateLimitStore = { hit: () => Promise.reject(new Error('redis fora')) } as never;
    const mw = rateLimiter(10, 60_000, quebrado, new Set(), segredo);
    for (let i = 0; i < 3; i++) {
      const next = vi.fn();
      mw({ url: '/pacientes', ip: '203.0.113.9', headers: {}, socket: {} } as never, resposta(), next);
      await vi.waitFor(() => expect(next).toHaveBeenCalled());
    }
    expect(log.eventos().filter((e) => e['evento'] === 'RATE_LIMIT_FAIL_OPEN' && e['motivo'] === 'rate_limit_por_ip')).toHaveLength(1);
    expect(log.tudo()).not.toContain('203.0.113.9');
  });

  it('escrita de origem fora da allowlist: 403 e UM CSRF_RECUSADO com a origem em HMAC (nunca o Origin nem o IP)', () => {
    const log = capturar();
    const mw = protecaoCsrf(new Set(['https://app.exemplo.test']));
    const r = resposta();
    const next = vi.fn();
    mw({ method: 'POST', url: '/x', ip: '203.0.113.9', headers: { origin: 'https://atacante.example' }, socket: {} } as unknown as IncomingMessage, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(403);
    expect(log.eventos().filter((e) => e['evento'] === 'CSRF_RECUSADO')).toEqual([expect.objectContaining({ motivo: 'origem_nao_permitida', origem: origemDaRequisicao('203.0.113.9') })]);
    expect(log.tudo()).not.toContain('atacante.example');
  });
});

describe('vigilância do portal (R2 do parecer do #138)', () => {
  const vig = () =>
    new PortalVigilanciaService(bancoFora as never, new MemoryRateLimitStore(), { config: VIGILANCIA_PADRAO, hashKey: segredo, fecharStore: false }, {
      contaMax: 2,
      contaJanelaMs: 60_000,
      resgateMax: 1000,
      resgateJanelaMs: 60_000,
    });
  const conta = '44444444-4444-4444-8444-444444444444';
  const vinculo = '55555555-5555-4555-8555-555555555555';

  it('limite por conta: um ALERTA_ANOMALIA e, com o banco fora, TRILHA_NAO_GRAVADA; 429', async () => {
    const log = capturar();
    const v = vig();
    await v.requisicao(conta, vinculo);
    await v.requisicao(conta, vinculo);
    await expect(v.requisicao(conta, vinculo)).rejects.toMatchObject({ status: 429 });
    const eventos = log.eventos();
    expect(eventos.filter((e) => e['evento'] === 'ALERTA_ANOMALIA')).toEqual([expect.objectContaining({ regra: 'portal_limite_por_conta' })]);
    expect(eventos.some((e) => e['evento'] === 'TRILHA_NAO_GRAVADA' && e['regra'] === 'portal_limite_por_conta')).toBe(true);
    expect(log.tudo()).not.toContain(conta);
  });

  it('teto diário de pedidos: ALERTA_ANOMALIA na primeira vez do dia e 429 sempre', async () => {
    const log = capturar();
    const v = vig();
    await expect(v.tetoDePedidos(conta, vinculo, 5)).rejects.toMatchObject({ status: 429 });
    await expect(v.tetoDePedidos(conta, vinculo, 5)).rejects.toMatchObject({ status: 429 });
    expect(log.eventos().filter((e) => e['evento'] === 'ALERTA_ANOMALIA')).toEqual([expect.objectContaining({ regra: 'portal_teto_diario_pedidos' })]);
  });

  it('contador do portal fora: RATE_LIMIT_FAIL_OPEN uma vez, e a chamada segue', async () => {
    const log = capturar();
    const quebrado: RateLimitStore = { hit: () => Promise.reject(new Error('redis fora')) } as never;
    const v = new PortalVigilanciaService(bancoFora as never, quebrado, { config: VIGILANCIA_PADRAO, hashKey: segredo, fecharStore: false }, { contaMax: 1, contaJanelaMs: 60_000, resgateMax: 1, resgateJanelaMs: 60_000 });
    for (let i = 0; i < 3; i++) await v.requisicao(conta, vinculo);
    expect(log.eventos().filter((e) => e['evento'] === 'RATE_LIMIT_FAIL_OPEN' && e['motivo'] === 'portal')).toHaveLength(1);
  });
});

describe('portal: resgate de convite leva a origem (R7 do parecer do #129)', () => {
  it('o controller passa ao serviço o HMAC do IP, nunca o IP', async () => {
    const chamadas: unknown[][] = [];
    const servico = {
      iniciarResgate: (...a: unknown[]) => (chamadas.push(a), Promise.resolve({})),
      resgatar: (...a: unknown[]) => (chamadas.push(a), Promise.resolve({})),
    };
    const c = new PortalController(servico as never);
    const sessao = { contaId: '66666666-6666-4666-8666-666666666666' } as never;
    await c.iniciarResgate(sessao, { ip: '198.51.100.7' }, {}, { token: 'x' });
    await c.resgatar(sessao, { headers: {} }, { ip: '198.51.100.7' }, {}, { token: 'x', codigo: '123456' });
    expect(chamadas[0]?.at(-1)).toBe(origemDaRequisicao('198.51.100.7'));
    expect(chamadas[1]?.at(-1)).toBe(origemDaRequisicao('198.51.100.7'));
    expect(JSON.stringify(chamadas)).not.toContain('198.51.100.7');
  });
});

describe('exportação total', () => {
  it('falha: EXPORTACAO_FALHOU com motivo genérico; a mensagem do erro nunca vai para o log', async () => {
    const log = capturar();
    const s = new ExportsService({ run: () => Promise.reject(new Error('Paciente Maria CPF 123.456.789-09')) } as never, 90, {} as never);
    await expect(s.exportTenantData(ctx)).rejects.toBeDefined();
    expect(log.eventos().find((e) => e['evento'] === 'EXPORTACAO_FALHOU')).toMatchObject({ tenantId: TENANT, userId: USER, motivo: 'erro_interno' });
    expect(log.tudo()).not.toContain('Maria');
    expect(log.tudo()).not.toContain('123.456');
  });
});
