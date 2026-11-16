/**
 * Quem pode cadastrar o fator (R8 do desenho do PR 3 × ALTA do parecer do #156). `cadastro_pendente_ate` é gravado só
 * pelo aceite do convite; sem a segunda metade da regra, o admin fundador e quem entra por `POST /clinica/membros`
 * ficam em 403 permanente, porque o MFA é obrigatório em todo perfil. Bancos falsos, sem rede.
 */
import { describe, expect, it } from 'vitest';
import type { Autenticacao } from './instancia';
import { BetterAuthProvider } from './provedor';

const SESSAO = 'sessao-ficticia-1';
const USER = '22222222-2222-4222-8222-222222222222';

/** Encadeamento do Drizzle (`.from().where()`) que resolve em `resultado` quando aguardado. */
function cadeia(resultado: unknown): unknown {
  const alvo: Record<string | symbol, unknown> = {};
  const p: unknown = new Proxy(alvo, {
    get: (_t, prop) =>
      prop === 'then'
        ? (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, erro)
        : () => p,
  });
  return p;
}

function montar(estado: { pendenteAte: Date | null; temFatorVerificado: boolean }) {
  const respostas: unknown[] = [
    [{ ate: estado.pendenteAte, usuarioId: USER }],
    estado.temFatorVerificado ? [{ id: 'fator-1' }] : [],
  ];
  const dbAuth = { select: () => cadeia(respostas.shift() ?? []) };
  const auth = { api: { getSession: () => Promise.resolve(null) } } as unknown as Autenticacao;
  return new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: {} as never });
}

describe('cadastroLiberado', () => {
  it('sessão do convite no prazo: liberado', async () => {
    const p = montar({ pendenteAte: new Date(Date.now() + 60_000), temFatorVerificado: false });
    expect(await p.cadastroLiberado(SESSAO)).toBe(true);
  });

  it('sem sessão de cadastro e SEM fator verificado (admin fundador, membro por rota): liberado', async () => {
    const p = montar({ pendenteAte: null, temFatorVerificado: false });
    expect(await p.cadastroLiberado(SESSAO)).toBe(true);
  });

  it('sem sessão de cadastro e COM fator verificado: recusado (trocar o fator continua pedindo convite ou recuperação)', async () => {
    const p = montar({ pendenteAte: null, temFatorVerificado: true });
    expect(await p.cadastroLiberado(SESSAO)).toBe(false);
  });

  it('prazo do cadastro vencido e fator já verificado: recusado', async () => {
    const p = montar({ pendenteAte: new Date(Date.now() - 60_000), temFatorVerificado: true });
    expect(await p.cadastroLiberado(SESSAO)).toBe(false);
  });

  it('sessão que não existe: recusado', async () => {
    const dbAuth = { select: () => cadeia([]) };
    const auth = { api: { getSession: () => Promise.resolve(null) } } as unknown as Autenticacao;
    const p = new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: {} as never });
    expect(await p.cadastroLiberado(SESSAO)).toBe(false);
  });
});

/**
 * Conta abandonada reaproveitada pelo aceite do convite (parecer do #156): o `senha === null` que a marca como
 * abandonada também é o `leftJoin` SEM linha de credencial. O UPDATE pegava 0 linhas e o aceite devolvia sucesso:
 * conta ativa, pessoa dentro da clínica e nenhuma senha com que entrar.
 */
function montarReaproveitamento(temLinhaDeCredencial: boolean) {
  const feito: string[] = [];
  const tx = {
    // A ordem é fixa no código: primeiro o `usuario`, depois a `conta` (comparar a tabela daria volta infinita no JSON).
    update: () => {
      const qual = feito.some((f) => f === 'update:usuario') ? 'conta' : 'usuario';
      return {
        set: () => ({
          where: () => ({
            returning: () => {
              feito.push(`update:${qual}`);
              if (qual === 'usuario') return Promise.resolve([{ id: USER }]);
              return Promise.resolve(temLinhaDeCredencial ? [{ id: 'conta-1' }] : []);
            },
          }),
        }),
      };
    },
    insert: () => ({
      values: () => {
        feito.push('insert:conta');
        return Promise.resolve(undefined);
      },
    }),
  };
  const dbAuth = { transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const auth = { api: { getSession: () => Promise.resolve(null) } } as unknown as Autenticacao;
  const provedor = new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: {} as never });
  return { provedor, feito };
}

const ENTRADA = {
  userId: USER,
  reaproveita: true,
  email: 'pessoa@exemplo.invalid',
  nome: 'Pessoa',
  senha: 'uma-senha-bem-comprida-de-teste',
  clinicaDeOrigem: '11111111-1111-4111-8111-111111111111',
  conviteDeOrigem: '44444444-4444-4444-8444-444444444444',
};

describe('criarContaDoConvite: conta abandonada volta a valer COM senha', () => {
  it('com linha de credencial: grava a senha nela, sem inserir outra', async () => {
    const { provedor, feito } = montarReaproveitamento(true);
    expect(await provedor.criarContaDoConvite(ENTRADA)).toEqual({ userId: USER });
    expect(feito).toEqual(['update:usuario', 'update:conta']);
  });

  it('SEM linha de credencial: insere a credencial em vez de devolver sucesso sem senha', async () => {
    const { provedor, feito } = montarReaproveitamento(false);
    expect(await provedor.criarContaDoConvite(ENTRADA)).toEqual({ userId: USER });
    expect(feito).toEqual(['update:usuario', 'update:conta', 'insert:conta']);
  });
});
