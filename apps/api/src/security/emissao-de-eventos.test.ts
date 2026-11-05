/**
 * R8 do parecer do #129 (e R3 do #136): cada módulo grava o evento certo no log de segurança, sem dado pessoal.
 * Webhook, vigilância de leitura (equipe), vigilância do portal e exportação, com dependências falsas e sem banco.
 */
import { Logger } from '@nestjs/common';
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhatsappWebhookController } from '../modules/messaging/whatsapp.controller';
import { VIGILANCIA_PADRAO, VigilanciaDeLeituraService } from '../modules/patients/vigilancia-de-leitura';
import { PortalVigilanciaService } from '../modules/portal/portal-vigilancia';
import { ExportsService } from '../modules/exports/exports.module';
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

describe('webhook do WhatsApp', () => {
  it('assinatura inválida: WEBHOOK_ASSINATURA_INVALIDA com a origem em HMAC, nunca o IP', async () => {
    const log = capturar();
    const controller = new WhatsappWebhookController({ adaptador: { assinaturaValida: () => false } } as never);
    await expect(controller.receber({ rawBody: Buffer.from('{}'), ip: '203.0.113.9', headers: {} } as never, 'sha256=forjada')).rejects.toBeDefined();
    const [e] = log.eventos().filter((x) => x['evento'] === 'WEBHOOK_ASSINATURA_INVALIDA');
    expect(e).toMatchObject({ motivo: 'whatsapp', severidade: 'alto' });
    expect(String(e?.['origem'])).toMatch(/^[0-9a-f]{16}$/);
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
