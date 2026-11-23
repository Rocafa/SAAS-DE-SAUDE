/**
 * Travas de papel do adaptador falso. A tela não pode ser a única guardiã: o que a API vai recusar
 * com 403 precisa ser recusado aqui também, senão a demonstração ensina um comportamento que o
 * servidor não permite.
 */
import { describe, expect, it } from 'vitest';
import { criarApiFake } from './fake';
import { ehAdmin, ehResponsavelTecnico, podeAprovarExportacao } from './papeis';

const agora = new Date('2026-10-12T10:00:00');

describe('ehAdmin', () => {
  it('só admin', () => {
    expect(ehAdmin('admin')).toBe(true);
    expect(ehAdmin('profissional')).toBe(false);
    expect(ehAdmin('recepcao')).toBe(false);
  });
});

describe('ehResponsavelTecnico', () => {
  it('só quem tem o vínculo de RT; ser admin não basta', async () => {
    expect(ehResponsavelTecnico({ responsavelTecnico: true })).toBe(true);
    expect(ehResponsavelTecnico({})).toBe(false);
    expect(ehResponsavelTecnico(null)).toBe(false);
    const rts = (await criarApiFake({ agora }).usuariosDemo()).filter(ehResponsavelTecnico).map((u) => u.id);
    expect(rts).toEqual(['u5']);
  });
});

describe('podeAprovarExportacao (o que a tela oferece)', () => {
  const adminNaoRt = { id: 'u1', papel: 'admin' as const };
  const adminRt = { id: 'u5', papel: 'admin' as const, responsavelTecnico: true };
  const rtNaoAdmin = { id: 'u2', papel: 'profissional' as const, responsavelTecnico: true };
  const aguardando = 'aguardando_rt' as const;
  it('pedido de admin: só o RT; quem pediu não vê o botão', () => {
    const p = { pedidoPor: 'u1', confirmacao: 'rt' as const, status: aguardando };
    expect(podeAprovarExportacao(adminNaoRt, p)).toBe(false);
    expect(podeAprovarExportacao(adminRt, p)).toBe(true);
    expect(podeAprovarExportacao(rtNaoAdmin, p)).toBe(true);
  });
  it('pedido do RT com outro admin ativo: só outro admin, nunca o RT que pediu', () => {
    const p = { pedidoPor: 'u5', confirmacao: 'admin' as const, status: aguardando };
    expect(podeAprovarExportacao(adminRt, p)).toBe(false);
    expect(podeAprovarExportacao(adminNaoRt, p)).toBe(true);
    expect(podeAprovarExportacao(rtNaoAdmin, p)).toBe(false);
  });
  it('autônomo: só o RT que pediu; pedido encerrado não oferece nada', () => {
    const p = { pedidoPor: 'u5', confirmacao: 'autoaprovacao' as const, status: aguardando };
    expect(podeAprovarExportacao(adminRt, p)).toBe(true);
    expect(podeAprovarExportacao(adminNaoRt, p)).toBe(false);
    expect(podeAprovarExportacao(adminRt, { ...p, status: 'pronto' })).toBe(false);
    expect(podeAprovarExportacao(adminRt, { ...p, status: 'cancelado' })).toBe(false);
  });
});

describe('o adaptador falso recusa o que é só do administrador', () => {
  const comoRecepcao = () => criarApiFake({ agora, papel: 'recepcao' });

  it('dados da clínica, equipe, convite e acesso (tirar e devolver)', async () => {
    const admin = criarApiFake({ agora });
    const clinica = await admin.obterClinica();
    const [membro] = await admin.listarEquipe();
    const api = comoRecepcao();
    await expect(api.salvarClinica({ ...clinica, nome: 'Outra Clínica Fictícia' })).rejects.toMatchObject({ status: 403 });
    await expect(api.devolverAcesso(membro!)).rejects.toMatchObject({ status: 403 });
    await expect(api.listarEquipe()).rejects.toMatchObject({ status: 403 });
    await expect(api.convidar('alguem@exemplo.test', 'recepcao')).rejects.toMatchObject({ status: 403 });
    await expect(api.removerAcesso('m1')).rejects.toMatchObject({ status: 403 });
  });

  it('trilha de acesso, assinatura e exportação total', async () => {
    const api = comoRecepcao();
    await expect(api.listarAuditoria()).rejects.toMatchObject({ status: 403 });
    await expect(api.cancelarAssinatura()).rejects.toMatchObject({ status: 403 });
    await expect(api.reativarAssinatura()).rejects.toMatchObject({ status: 403 });
    await expect(api.pedirExportacao('123456')).rejects.toMatchObject({ status: 403 });
    await expect(api.obterExportacaoPendente()).rejects.toMatchObject({ status: 403 });
    await expect(api.aprovarExportacao('x1', '123456')).rejects.toMatchObject({ status: 403 });
  });

  it('profissional não aprova um pedido de exportação criado pelo administrador', async () => {
    const api = criarApiFake({ agora });
    const pedido = await api.pedirExportacao('123456');
    await api.entrarComo('u2');
    await expect(api.aprovarExportacao(pedido.id, '123456')).rejects.toMatchObject({ status: 403, codigo: 'proibido' });
  });

  it('o administrador continua passando', async () => {
    const api = criarApiFake({ agora });
    expect((await api.listarEquipe()).length).toBeGreaterThan(0);
    expect((await api.listarAuditoria()).length).toBeGreaterThan(0);
  });
});
