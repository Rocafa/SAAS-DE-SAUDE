import { describe, expect, it, vi } from 'vitest';
import { avisoDeEsperaNaoRemovida, textoDoErro } from './desfazer';
import { ErroApi } from '@/lib/api/http';

describe('textoDoErro (formatador de erro para a tela)', () => {
  it('usa a mensagem do ErroApi quando é instância de ErroApi', () => {
    const erro = new ErroApi('Paciente não encontrado.', 404);
    expect(textoDoErro(erro)).toBe('Paciente não encontrado.');
  });

  it('usa a mensagem genérica para TypeError (erro de rede)', () => {
    const erro = new TypeError('Failed to fetch');
    expect(textoDoErro(erro)).toBe('Não deu certo. Tente de novo.');
  });

  it('usa a mensagem genérica para Error genérico', () => {
    const erro = new Error('Internal server error');
    expect(textoDoErro(erro)).toBe('Não deu certo. Tente de novo.');
  });

  it('usa a mensagem genérica para null', () => {
    expect(textoDoErro(null)).toBe('Não deu certo. Tente de novo.');
  });

  it('usa a mensagem genérica para undefined', () => {
    expect(textoDoErro(undefined)).toBe('Não deu certo. Tente de novo.');
  });

  it('usa a mensagem genérica para string', () => {
    expect(textoDoErro('algo deu errado')).toBe('Não deu certo. Tente de novo.');
  });

  it('usa a mensagem genérica para objeto sem message', () => {
    expect(textoDoErro({ codigo: 'ERRO' })).toBe('Não deu certo. Tente de novo.');
  });

  it('permite mensagem genérica customizada', () => {
    const erro = new Error('qualquer coisa');
    expect(textoDoErro(erro, 'Erro personalizado')).toBe('Erro personalizado');
  });

  it('ErroApi com status 401 mostra a mensagem do erro', () => {
    const erro = new ErroApi('Sessão expirada. Entre de novo.', 401);
    expect(textoDoErro(erro)).toBe('Sessão expirada. Entre de novo.');
  });

  it('ErroApi com status 403 mostra a mensagem do erro', () => {
    const erro = new ErroApi('Você não tem permissão para esta ação.', 403);
    expect(textoDoErro(erro)).toBe('Você não tem permissão para esta ação.');
  });

  it('ErroApi com status 500 mostra a mensagem do erro', () => {
    const erro = new ErroApi('Erro interno do servidor.', 500);
    expect(textoDoErro(erro)).toBe('Erro interno do servidor.');
  });
});

describe('avisoDeEsperaNaoRemovida (consulta marcada, mas a espera não saiu)', () => {
  it('é UM aviso só: junta o texto com o motivo e mantém o Desfazer da consulta', async () => {
    const desfazer = vi.fn();
    const aviso = avisoDeEsperaNaoRemovida({ texto: 'Consulta marcada: Ana, hoje às 14:00.', desfazer }, new ErroApi('Sessão expirada. Entre de novo.', 401));
    expect(aviso.texto).toBe('Consulta marcada, mas não deu para tirar da lista de espera. Sessão expirada. Entre de novo.');
    expect(aviso.erro).toBe(true);
    expect(aviso.desfazer).toBe(desfazer);
  });

  it('com erro que não é ErroApi usa a mensagem genérica de textoDoErro', () => {
    const aviso = avisoDeEsperaNaoRemovida({ texto: 'x' }, new TypeError('Failed to fetch'));
    expect(aviso.texto).toBe('Consulta marcada, mas não deu para tirar da lista de espera. Não deu certo. Tente de novo.');
  });
});
