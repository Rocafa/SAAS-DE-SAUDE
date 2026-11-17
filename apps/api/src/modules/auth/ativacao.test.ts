/**
 * Mapeamento HTTP de `POST /ativacao/usar` (T2 do parecer do Guardião de 17/11/2026): 404 e 503 da regra, token só no
 * corpo e `exigirObjeto` recusando campo extra. Sem banco: o provedor é um dublê. Dados fictícios.
 */
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { AtivacaoController, AtivacaoService } from './ativacao';
import { AUTH_PROVIDER, type AuthProvider, type ResultadoDaAtivacao } from './auth-context';

const TOKEN = 'TokenFicticioDeAtivacao0123456789abcdefghijklmnopqrstuvwxyzABCD';
const corpoValido = { token: TOKEN, email: 'fundadora.ficticia@exemplo.test', nome: 'Fundadora Ficticia', senha: 'Senha-Ficticia-de-Teste-1' };

const usarAtivacao = vi.fn<(e: { token: string }) => Promise<ResultadoDaAtivacao>>();
const provedorFicticio = { usarAtivacao } as unknown as AuthProvider;

/** Captura a rejeição para conferir a classe, sem `rejects.toThrow()` genérico. */
async function recusa(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (x: unknown) => x,
  );
}

describe('AtivacaoService: resultado do provedor → erro de domínio', () => {
  const servico = new AtivacaoService(provedorFicticio);
  const entrada = { token: TOKEN, email: corpoValido.email, senha: corpoValido.senha, cabecalhos: new Headers() };

  beforeEach(() => usarAtivacao.mockReset());

  it('invalido → NaoEncontradoError (404 genérico)', async () => {
    usarAtivacao.mockResolvedValue('invalido');
    const e = await recusa(servico.usar(entrada));
    expect(e).toBeInstanceOf(NaoEncontradoError);
    expect((e as NaoEncontradoError).getStatus()).toBe(404);
    expect((e as NaoEncontradoError).getResponse()).toEqual({ statusCode: 404, message: 'Não encontrado' });
  });

  it('indisponivel → ServiceUnavailableException (503, falha fechada)', async () => {
    usarAtivacao.mockResolvedValue('indisponivel');
    const e = await recusa(servico.usar(entrada));
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect((e as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it.each([
    ['entrada_invalida', 'entrada_invalida'],
    ['nome_obrigatorio', 'nome_obrigatorio'],
    ['codigo_obrigatorio', 'conta_existente_exige_login'],
    ['senha_vazada', 'senha_vazada'],
    ['credencial_errada', 'credenciais_invalidas'],
    ['conta_sem_fator', 'conta_sem_fator'],
  ] as const)('%s → ConflitoError com codigo %s', async (resultado, codigo) => {
    usarAtivacao.mockResolvedValue(resultado);
    const e = await recusa(servico.usar(entrada));
    expect(e).toBeInstanceOf(ConflitoError);
    expect((e as ConflitoError).codigo).toBe(codigo);
  });

  it('provedor sem ativação → 404, sem revelar a rota', async () => {
    const e = await recusa(new AtivacaoService({} as AuthProvider).usar(entrada));
    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as NotFoundException).getStatus()).toBe(404);
  });
});

describe('POST /ativacao/usar (HTTP)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AtivacaoController],
      providers: [AtivacaoService, { provide: AUTH_PROVIDER, useValue: provedorFicticio }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => usarAtivacao.mockReset());

  it('token inválido, vencido, usado ou fundador que não confere: 404 genérico, sem cookie', async () => {
    usarAtivacao.mockResolvedValue('invalido');
    const r = await http().post('/ativacao/usar').send(corpoValido);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ statusCode: 404, message: 'Não encontrado' });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('contador fora do ar: 503', async () => {
    usarAtivacao.mockResolvedValue('indisponivel');
    const r = await http().post('/ativacao/usar').send(corpoValido);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ statusCode: 503 });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('conta nova: 204 com os cookies da sessão de cadastro', async () => {
    usarAtivacao.mockResolvedValue({ cookies: ['sessao_ficticia=abc; Path=/; HttpOnly'], contaExistente: false });
    const r = await http().post('/ativacao/usar').send(corpoValido);
    expect(r.status).toBe(204);
    expect(r.headers['set-cookie']).toEqual(['sessao_ficticia=abc; Path=/; HttpOnly']);
  });

  it('token só no corpo: na query é ignorado (400 token, sem chamar o provedor)', async () => {
    const semToken = { email: corpoValido.email, nome: corpoValido.nome, senha: corpoValido.senha };
    const r = await http().post(`/ativacao/usar?token=${TOKEN}`).send(semToken);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['token'] });
    expect(usarAtivacao).not.toHaveBeenCalled();
  });

  it('token no corpo e outro na query: vale o do corpo', async () => {
    usarAtivacao.mockResolvedValue({ cookies: [], contaExistente: true });
    const r = await http().post('/ativacao/usar?token=OutroTokenFicticioNaQuery0123456789').send(corpoValido);
    expect(r.status).toBe(204);
    expect(usarAtivacao).toHaveBeenCalledTimes(1);
    expect(usarAtivacao.mock.calls[0]?.[0].token).toBe(TOKEN);
  });

  it('exigirObjeto recusa campo extra (400 campo_desconhecido) sem chamar o provedor', async () => {
    const r = await http()
      .post('/ativacao/usar')
      .send({ ...corpoValido, clinicaId: '00000000-0000-4000-8000-000000000001' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['campo_desconhecido'] });
    expect(usarAtivacao).not.toHaveBeenCalled();
  });

  it('corpo que não é objeto: EntradaInvalidaError no controller (400 corpo)', async () => {
    const controller = new AtivacaoController(new AtivacaoService(provedorFicticio));
    const e = await recusa(controller.usar(['lista'], { headers: {} }, { append: () => undefined }));
    expect(e).toBeInstanceOf(EntradaInvalidaError);
    expect((e as EntradaInvalidaError).campos).toEqual(['corpo']);
    expect(usarAtivacao).not.toHaveBeenCalled();
  });
});
