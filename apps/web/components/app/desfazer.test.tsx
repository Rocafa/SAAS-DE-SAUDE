import { describe, expect, it } from 'vitest';
import { textoDoErro } from './desfazer';
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
