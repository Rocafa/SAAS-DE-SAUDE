/**
 * Troca do admin único (B13): conferências que saem ANTES de qualquer escrita (R2 viva voz, R4 mesmo operador, P2,
 * janela). Banco falso: a única leitura é a da linha da troca. O caminho no banco está em
 * test/troca-do-admin-unico.rls.test.ts. Dados fictícios.
 */
import { describe, expect, it, vi } from 'vitest';
import { emitirTrocaDoAdmin, pedirTrocaDoAdmin, TrocaRecusada, type PedidoDeTroca } from './troca-do-admin';

const PEDIDO = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CLINICA = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const ANTIGO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const NOVO = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';
const OPERADOR_A = '11111111-2222-4333-8444-555555555555';
const OPERADOR_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const AGORA = new Date('2026-11-24T12:00:00.000Z');
const agora = () => AGORA;

/** Encadeamento do Drizzle que resolve em `resultado` quando aguardado. */
function cadeia(resultado: unknown): unknown {
  const p: unknown = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then' ? (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, erro) : () => p,
    },
  );
  return p;
}

function bancoComTroca(over: Record<string, unknown> = {}) {
  const transaction = vi.fn(() => Promise.reject(new Error('não devia abrir transação')));
  const linha = { id: PEDIDO, clinicaId: CLINICA, usuarioAntigo: ANTIGO, usuarioNovo: NOVO, operadorPedido: OPERADOR_A, chamado: 'SUP-77', liberaEm: new Date('2026-11-24T10:00:00.000Z'), estado: 'aguardando', reemissoes: 0, ...over };
  return { db: { select: () => cadeia([linha]), transaction } as never, transaction };
}

const recusa = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as TrocaRecusada | null)?.codigo;

function pedido(over: Partial<PedidoDeTroca> = {}): PedidoDeTroca {
  return {
    pedido: PEDIDO,
    clinicaId: CLINICA,
    usuarioAntigo: ANTIGO,
    chamado: 'SUP-77',
    contrato: 'CTR-9',
    motivo: 'perdeu_senha_e_fator',
    operador: OPERADOR_A,
    vivaVoz: '2026-11-24T11:30:00Z',
    suspenderContaAntiga: false,
    email: 'conta.nova.ficticia@exemplo.test',
    ...over,
  };
}

describe('B13 pedir: conferências antes do banco', () => {
  const semBanco = { transaction: () => Promise.reject(new Error('não devia abrir transação')) } as never;

  it('R2: sem viva voz, com hora no futuro, velha demais ou fora do formato: viva_voz_ausente', async () => {
    for (const vivaVoz of ['', '2026-11-24T12:30:00Z', '2026-11-23T11:00:00Z', '24/11/2026 11:30', '2026-11-24T11:30:00-03:00']) {
      expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ vivaVoz }), { agora })), vivaVoz).toBe('viva_voz_ausente');
    }
  });

  it('P2 (padrão até decisão dos sócios): suspender a conta antiga só com suspeita_de_invasao', async () => {
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ suspenderContaAntiga: true }), { agora }))).toBe('motivo_invalido');
  });

  it('chamado, contrato, motivo e e-mail fora do formato saem sem tocar no banco', async () => {
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ chamado: 'Fulano' }), { agora }))).toBe('chamado_invalido');
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ contrato: 'contrato 1' }), { agora }))).toBe('contrato_invalido');
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ motivo: 'outro' as never }), { agora }))).toBe('motivo_invalido');
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ email: 'sem-arroba' }), { agora }))).toBe('parametro_invalido');
    expect(await recusa(pedirTrocaDoAdmin(semBanco, pedido({ usuarioAntigo: '00000000-0000-0000-0000-000000000000' }), { agora }))).toBe('entrada_invalida');
  });
});

describe('B13 emitir: conferências antes da transação', () => {
  const guardar = vi.fn(() => Promise.resolve());

  it('R4: quem rodou o pedir não emite (mesmo_operador), sem abrir transação nem guardar token', async () => {
    const { db, transaction } = bancoComTroca();
    expect(await recusa(emitirTrocaDoAdmin(db, { pedido: PEDIDO, chamado: 'SUP-77', operador: OPERADOR_A, vivaVoz: '2026-11-24T11:00:00Z' }, guardar, { agora }))).toBe('mesmo_operador');
    expect(transaction).not.toHaveBeenCalled();
    expect(guardar).not.toHaveBeenCalled();
  });

  it('janela ainda aberta: janela_aberta', async () => {
    const { db } = bancoComTroca({ liberaEm: new Date('2026-11-25T10:00:00.000Z') });
    expect(await recusa(emitirTrocaDoAdmin(db, { pedido: PEDIDO, chamado: 'SUP-77', operador: OPERADOR_B, vivaVoz: '2026-11-24T11:00:00Z' }, guardar, { agora }))).toBe('janela_aberta');
  });

  it('R2: a viva voz do emitir tem de ser DEPOIS da janela', async () => {
    const { db, transaction } = bancoComTroca();
    expect(await recusa(emitirTrocaDoAdmin(db, { pedido: PEDIDO, chamado: 'SUP-77', operador: OPERADOR_B, vivaVoz: '2026-11-24T09:00:00Z' }, guardar, { agora }))).toBe('viva_voz_ausente');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('chamado diferente do da troca: chamado_invalido', async () => {
    const { db } = bancoComTroca();
    expect(await recusa(emitirTrocaDoAdmin(db, { pedido: PEDIDO, chamado: 'SUP-78', operador: OPERADOR_B, vivaVoz: '2026-11-24T11:00:00Z' }, guardar, { agora }))).toBe('chamado_invalido');
  });
});
