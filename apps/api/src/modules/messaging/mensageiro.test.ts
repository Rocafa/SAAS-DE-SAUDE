import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { corpoNaMeta, MODELOS_DA_PLATAFORMA, MODELO_PADRAO, textoEhNeutro, corpoDeModeloValido, responsavelRepresentaParaLembrete, sigiloDoAdolescenteNoLembrete } from './lembretes-regras';
import { MensageiroCloudApi, type ClienteHttp } from './mensageiro-cloud-api';
import { MensageiroFalso } from './mensageiro-falso';
import { criarMensageiro } from './mensageiro.factory';
import { assinarCorpo, lerEventosDoWebhook, MAX_EVENTOS_POR_WEBHOOK, ModeloDivergenteError, WebhookInvalidoError } from './mensageiro-whatsapp';

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
    // Sem a conta dos modelos (WABA) não há como conferir o texto na Meta: não sobe (V3 do parecer #69).
    const quaseTudo = {
      NODE_ENV: 'production',
      WHATSAPP_PROVEDOR: 'cloud_api',
      WHATSAPP_R17_CLAUSULAS_PADRAO: 'assinadas',
      WHATSAPP_ACCESS_TOKEN: randomBytes(16).toString('hex'),
      WHATSAPP_APP_SECRET: randomBytes(32).toString('base64'),
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: randomBytes(16).toString('hex'),
    };
    expect(() => criarMensageiro(quaseTudo)).toThrow(/WHATSAPP_WABA_ID/);
    expect(criarMensageiro({ ...quaseTudo, WHATSAPP_WABA_ID: '200000000000001' })?.nome).toBe('cloud_api');
  });

  it('valor desconhecido derruba o boot', () => {
    expect(() => criarMensageiro({ NODE_ENV: 'test', WHATSAPP_PROVEDOR: 'zap' })).toThrow();
  });
});

describe('esqueleto da Cloud API (sem rede: cliente HTTP injetado)', () => {
  const credenciais = { tokenDeAcesso: randomBytes(24).toString('base64url'), segredoDoApp: segredo, tokenInscricao: token, versaoGraph: 'v21.0', contaWaba: '200000000000001' };
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
      enviado = { url, body: JSON.parse(init.body ?? 'null') };
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

describe('modelos: só os da plataforma, nome na Meta e texto conferidos juntos (V3 do parecer #69)', () => {
  const credenciais = { tokenDeAcesso: randomBytes(24).toString('base64url'), segredoDoApp: segredo, tokenInscricao: token, versaoGraph: 'v21.0', contaWaba: '200000000000001' };
  const naMeta = (corpo: string, extra: Record<string, unknown> = {}) =>
    ({ name: MODELO_PADRAO.nomeNoProvedor, language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: corpo }], ...extra });
  const meta = (dados: unknown[], status = 200): ClienteHttp => () => Promise.resolve({ status, json: () => Promise.resolve({ data: dados }) });

  it('lista fechada: cada modelo é neutro, só com {clinica}/{data}/{hora}, e vira {{1}}..{{3}} na Meta', () => {
    expect(MODELOS_DA_PLATAFORMA.length).toBeGreaterThanOrEqual(1);
    for (const m of MODELOS_DA_PLATAFORMA) {
      expect(m.nomeNoProvedor).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(corpoDeModeloValido(m.corpo)).toBe(true);
      expect(textoEhNeutro(m.corpo)).toBe(true);
      expect(corpoNaMeta(m.corpo)).not.toMatch(/\{(clinica|data|hora)\}/);
    }
    expect(corpoNaMeta('a {clinica} b {data} c {hora}')).toBe('a {{1}} b {{2}} c {{3}}');
  });

  it('texto igual e aprovado na Meta: sobe; consulta a conta certa', async () => {
    let url = '';
    const http: ClienteHttp = (u) => {
      url = u;
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ data: [naMeta(corpoNaMeta(MODELO_PADRAO.corpo))] }) });
    };
    await new MensageiroCloudApi(credenciais, http).conferirModelos(MODELOS_DA_PLATAFORMA);
    expect(url).toContain('/v21.0/200000000000001/message_templates?name=lembrete_neutro_v1');
  });

  it('texto diferente, cabeçalho extra, não aprovado, ausente ou consulta falha: NÃO sobe', async () => {
    const certo = corpoNaMeta(MODELO_PADRAO.corpo);
    const casos: [ClienteHttp, string][] = [
      [meta([naMeta('Sua sessão de psicoterapia em {{1}} dia {{2}} às {{3}}.')]), 'texto_diferente'],
      [meta([naMeta(certo, { components: [{ type: 'HEADER', text: 'Clínica de oncologia' }, { type: 'BODY', text: certo }] })]), 'texto_diferente'],
      [meta([naMeta(certo, { status: 'PENDING' })]), 'nao_aprovado'],
      [meta([naMeta(certo, { language: 'en_US' })]), 'ausente'],
      [meta([]), 'ausente'],
      [meta([], 500), 'consulta_falhou'],
      [() => Promise.reject(new Error('sem rede')), 'consulta_falhou'],
    ];
    for (const [http, motivo] of casos) {
      const err = await new MensageiroCloudApi(credenciais, http).conferirModelos(MODELOS_DA_PLATAFORMA).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, motivo).toBeInstanceOf(ModeloDivergenteError);
      expect((err as ModeloDivergenteError).motivo).toBe(motivo);
    }
  });
});

describe('R4 do #69: o responsável representa para o lembrete?', () => {
  const hoje = '2026-10-22';
  it('pai/mãe, tutor e representante: só para menor não emancipado, com data de nascimento', () => {
    for (const tipo of ['pai_mae', 'tutor', 'representante'] as const) {
      expect(responsavelRepresentaParaLembrete(tipo, '2015-03-01', null, hoje), tipo).toBe(true);
      expect(responsavelRepresentaParaLembrete(tipo, '2008-10-22', null, hoje), `${tipo} faz 18 hoje`).toBe(false);
      expect(responsavelRepresentaParaLembrete(tipo, '2008-10-23', null, hoje), `${tipo} faz 18 amanhã`).toBe(true);
      expect(responsavelRepresentaParaLembrete(tipo, '2009-05-01', '2026-10-01', hoje), `${tipo} emancipado`).toBe(false);
      expect(responsavelRepresentaParaLembrete(tipo, '2009-05-01', '2026-10-23', hoje), `${tipo} emancipação futura`).toBe(true);
      expect(responsavelRepresentaParaLembrete(tipo, null, null, hoje), `${tipo} sem nascimento`).toBe(false);
    }
  });
  it('curatela: vale para o adulto', () => {
    expect(responsavelRepresentaParaLembrete('curador', '1980-01-01', null, hoje)).toBe(true);
    expect(responsavelRepresentaParaLembrete('curador', null, null, hoje)).toBe(true);
  });
  it('0055: apoiador (decisão apoiada) nunca representa para o lembrete; sigilo como na curatela', () => {
    expect(responsavelRepresentaParaLembrete('apoiador', '1980-01-01', null, hoje)).toBe(false);
    expect(responsavelRepresentaParaLembrete('apoiador', '2015-03-01', null, hoje)).toBe(false);
    expect(responsavelRepresentaParaLembrete('apoiador', null, null, hoje)).toBe(false);
    expect(sigiloDoAdolescenteNoLembrete('apoiador', '1980-01-01', hoje)).toBe(true);
  });
  it('R4 (c): sigilo do adolescente a partir dos 12 anos, com idade desconhecida e na curatela', () => {
    expect(sigiloDoAdolescenteNoLembrete('pai_mae', '2014-10-23', hoje)).toBe(false);
    expect(sigiloDoAdolescenteNoLembrete('pai_mae', '2014-10-22', hoje)).toBe(true);
    expect(sigiloDoAdolescenteNoLembrete('tutor', null, hoje)).toBe(true);
    expect(sigiloDoAdolescenteNoLembrete('curador', '1980-01-01', hoje)).toBe(true);
  });
});
