/**
 * Travas de papel do adaptador falso. A tela não pode ser a única guardiã: o que a API vai recusar
 * com 403 precisa ser recusado aqui também, senão a demonstração ensina um comportamento que o
 * servidor não permite.
 */
import { describe, expect, it } from 'vitest';
import { criarApiFake } from './fake';
import { ehAdmin } from './papeis';

const agora = new Date('2026-10-12T10:00:00');

describe('ehAdmin', () => {
  it('só admin', () => {
    expect(ehAdmin('admin')).toBe(true);
    expect(ehAdmin('profissional')).toBe(false);
    expect(ehAdmin('recepcao')).toBe(false);
  });
});

describe('o adaptador falso recusa o que é só do administrador', () => {
  const comoRecepcao = () => criarApiFake({ agora, papel: 'recepcao' });

  it('equipe, convite e acesso', async () => {
    const api = comoRecepcao();
    await expect(api.listarEquipe()).rejects.toMatchObject({ status: 403 });
    await expect(api.convidar('alguem@exemplo.test', 'recepcao')).rejects.toMatchObject({ status: 403 });
    await expect(api.removerAcesso('m1')).rejects.toMatchObject({ status: 403 });
  });

  it('trilha de acesso, assinatura e exportação total', async () => {
    const api = comoRecepcao();
    await expect(api.listarAuditoria()).rejects.toMatchObject({ status: 403 });
    await expect(api.cancelarAssinatura()).rejects.toMatchObject({ status: 403 });
    await expect(api.pedirExportacao('123456')).rejects.toMatchObject({ status: 403 });
    await expect(api.aprovarExportacao('x1')).rejects.toMatchObject({ status: 403 });
  });

  it('o administrador continua passando', async () => {
    const api = criarApiFake({ agora });
    expect((await api.listarEquipe()).length).toBeGreaterThan(0);
    expect((await api.listarAuditoria()).length).toBeGreaterThan(0);
  });
});
