import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MensageiroCloudApi, type ClienteHttp } from './mensageiro-cloud-api';
import { MensageiroFalso } from './mensageiro-falso';
import { criarMensageiro } from './mensageiro.factory';
import { assinarCorpo, lerEventosDoWebhook, MAX_EVENTOS_POR_WEBHOOK, WebhookInvalidoError } from './mensageiro-whatsapp';

const segredo = randomBytes(32);
const token = randomBytes(24).toString('base64url');

function corpoDeStatus(n: number): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '100000000000001' },
              statuses: Array.from({ length: n }, (_, i) => ({ id: `wamid.T${i}`, status: 'delivered', timestamp: '1900000000' })),
            },
          },
        ],
      },
    ],
  });
}

describe('assinatura do webhook (HMAC-SHA256, formato da Meta)', () => {
  const falso = new MensageiroFalso({ segredoWebhook: segredo, tokenInscricao: token, nodeEnv: 'test' });
  const corpo = Buffer.from(corpoDeStatus(1));

  it('aceita a assinatura certa do corpo bruto', () => {
    expect(falso.assinaturaValida(corpo, assinarCorpo(segredo, corpo))).toBe(true);
  });

  it('recusa assinatura ausente, malformada, de outro segredo ou de corpo alterado', () => {
    expect(falso.assinaturaValida(corpo, undefined)).toBe(false);
    expect(falso.assinaturaValida(corpo, 'sha256=xyz')).toBe(false);
    expect(falso.assinaturaValida(corpo, assinarCorpo(randomBytes(32), corpo))).toBe(false);
    const alterado = Buffer.from(corpo.toString().replace('delivered', 'read'));
    expect(falso.assinaturaValida(alterado, assinarCorpo(segredo, corpo))).toBe(false);
  });

  it('sem segredo configurado, nada é válido (falha fechada)', () => {
    const semSegredo = new MensageiroFalso({ nodeEnv: 'test' });
    expect(semSegredo.assinaturaValida(corpo, assinarCorpo(segredo, corpo))).toBe(false);
  });

  it('inscrição: só devolve o desafio com modo subscribe e token certo', () => {
    expect(falso.desafioDaInscricao('subscribe', token, 'abc123')).toBe('abc123');
    expect(falso.desafioDaInscricao('subscribe', 'errado', 'abc123')).toBeNull();
    expect(falso.desafioDaInscricao('outro', token, 'abc123')).toBeNull();
    expect(falso.desafioDaInscricao('subscribe', token, '<script>')).toBeNull();
  });
});

describe('leitura dos eventos', () => {
  it('lê status e respostas (texto, botão, interativo) e ignora item malformado', () => {
    const eventos = lerEventosDoWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '100000000000001' },
                statuses: [{ id: 'wamid.A', status: 'read', timestamp: '1900000000' }, { id: 'wamid.B', status: 'desconhecido' }],
                messages: [
                  { id: 'wamid.R1', from: '5511900000001', type: 'text', text: { body: '1' }, context: { id: 'wamid.A' } },
                  { id: 'wamid.R2', from: '5511900000001', type: 'button', button: { payload: '2' } },
                  { id: 'wamid.R3', from: '5511900000001', type: 'interactive', interactive: { button_reply: { id: '1', title: 'Confirmar' } } },
                  { id: 'wamid.R4', from: 'nao-numero', type: 'text', text: { body: '1' } },
                  { id: 'wamid.R5', from: '5511900000001', type: 'image', image: { id: 'x' } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(eventos.map((e) => `${e.tipo}:${e.idProvedor}`)).toEqual([
      'status:wamid.A',
      'resposta:wamid.R1',
      'resposta:wamid.R2',
      'resposta:wamid.R3',
      'resposta:wamid.R5',
    ]);
    const r1 = eventos[1];
    expect(r1?.tipo === 'resposta' && r1.emRespostaA).toBe('wamid.A');
    const r5 = eventos[4];
    expect(r5?.tipo === 'resposta' && r5.texto).toBe('');
  });

  it('corpo fora do formato ou com eventos demais é recusado inteiro', () => {
    expect(() => lerEventosDoWebhook({ object: 'page' })).toThrow(WebhookInvalidoError);
    expect(() => lerEventosDoWebhook(JSON.parse(corpoDeStatus(MAX_EVENTOS_POR_WEBHOOK + 1)))).toThrow(WebhookInvalidoError);
    expect(lerEventosDoWebhook(JSON.parse(corpoDeStatus(MAX_EVENTOS_POR_WEBHOOK)))).toHaveLength(MAX_EVENTOS_POR_WEBHOOK);
  });
});

describe('escolha do adaptador (lista fechada, desligado por padrão)', () => {
  it('sem variável: desligado', () => {
    expect(criarMensageiro({ NODE_ENV: 'test' })).toBeNull();
  });

  it('falso só em development/test', () => {
    expect(criarMensageiro({ NODE_ENV: 'test', WHATSAPP_PROVEDOR: 'falso' })?.nome).toBe('falso');
    expect(() => criarMensageiro({ NODE_ENV: 'production', WHATSAPP_PROVEDOR: 'falso' })).toThrow();
    expect(() => criarMensageiro({ NODE_ENV: 'staging', WHATSAPP_PROVEDOR: 'falso' })).toThrow();
  });

  it('cloud_api exige as cláusulas-padrão da ANPD e as credenciais do ambiente', () => {
    expect(() => criarMensageiro({ NODE_ENV: 'production', WHATSAPP_PROVEDOR: 'cloud_api' })).toThrow(/cláusulas-padrão/);
    expect(() => criarMensageiro({ NODE_ENV: 'production', WHATSAPP_PROVEDOR: 'cloud_api', WHATSAPP_R17_CLAUSULAS_PADRAO: 'assinadas' })).toThrow(/credencial/);
  });

  it('valor desconhecido derruba o boot', () => {
    expect(() => criarMensageiro({ NODE_ENV: 'test', WHATSAPP_PROVEDOR: 'zap' })).toThrow();
  });
});

describe('esqueleto da Cloud API (sem rede: cliente HTTP injetado)', () => {
  const credenciais = { tokenDeAcesso: randomBytes(24).toString('base64url'), segredoDoApp: segredo, tokenInscricao: token, versaoGraph: 'v21.0' };
  const mensagem = {
    para: '5511900000001',
    remetente: '100000000000001',
    modelo: { nomeNoProvedor: 'lembrete_neutro_v1', idioma: 'pt_BR' as const, parametros: ['Agendamentos', '10/05', '09:00'] },
    texto: 'irrelevante',
    idempotencia: 'id-1',
  };

  it('manda MODELO com parâmetros (nunca texto livre) e lê o id', async () => {
    let enviado: { url: string; body: unknown } | undefined;
    const http: ClienteHttp = (url, init) => {
      enviado = { url, body: JSON.parse(init.body) };
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ messages: [{ id: 'wamid.X' }] }) });
    };
    const r = await new MensageiroCloudApi(credenciais, http).enviar(mensagem);
    expect(r).toEqual({ ok: true, idProvedor: 'wamid.X' });
    expect(enviado?.url).toBe('https://graph.facebook.com/v21.0/100000000000001/messages');
    expect(enviado?.body).toMatchObject({ type: 'template', template: { name: 'lembrete_neutro_v1' } });
    expect(JSON.stringify(enviado?.body)).not.toContain('irrelevante');
  });

  it('classifica falha definitiva (4xx) e temporária (429/5xx/rede)', async () => {
    const com = (status: number): ClienteHttp => () => Promise.resolve({ status, json: () => Promise.resolve({ error: { code: 131026 } }) });
    expect(await new MensageiroCloudApi(credenciais, com(400)).enviar(mensagem)).toEqual({ ok: false, codigo: '131026', definitivo: true });
    expect(await new MensageiroCloudApi(credenciais, com(429)).enviar(mensagem)).toMatchObject({ ok: false, definitivo: false });
    expect(await new MensageiroCloudApi(credenciais, com(503)).enviar(mensagem)).toMatchObject({ ok: false, definitivo: false });
    const rede: ClienteHttp = () => Promise.reject(new Error('sem rede'));
    expect(await new MensageiroCloudApi(credenciais, rede).enviar(mensagem)).toEqual({ ok: false, codigo: 'rede', definitivo: false });
  });
});
