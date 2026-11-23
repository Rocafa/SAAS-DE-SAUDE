// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErroApi } from '@/lib/api/http';
import type { ApiClinica } from '@/lib/api/cliente';
import type { ItemEspera, Paciente } from '@/lib/api/tipos';
import { ListaEspera } from './agenda-visoes';
import { AvisosProvider } from './desfazer';

const espera: ItemEspera[] = [
  { id: 'e1', pacienteId: 'p1', preferencia: 'terça de manhã', criadoEm: '2026-11-20' },
  { id: 'e2', pacienteId: 'p2', preferencia: 'quinta à tarde', criadoEm: '2026-11-21' },
];

const pacientes: Paciente[] = [
  { id: 'p1', nome: 'Ana Souza', telefone: '', cpf: '', nascimento: '1990-01-01', responsaveis: [], ativo: true, ficticio: true },
  { id: 'p2', nome: 'Bruno Lima', telefone: '', cpf: '', nascimento: '1985-05-05', responsaveis: [], ativo: true, ficticio: true },
];

const atualizar = vi.fn();
let api: Pick<ApiClinica, 'adicionarEspera' | 'removerEspera' | 'devolverEspera'>;

// A tela só usa `api`, `atualizar`, `pacientes` e a consulta da lista: o resto do provedor não importa aqui.
vi.mock('./dados', () => ({
  useDados: () => ({ api, atualizar, pacientes }),
  useConsulta: () => ({ estado: 'pronto', dados: espera }),
}));

/** Promessa que o teste resolve ou rejeita quando quiser, para ver a tela no meio da operação. */
function adiada<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

/** Sem jest-dom no repo: lê a propriedade do botão direto. */
function desabilitado(el: HTMLElement | undefined): boolean {
  return (el as HTMLButtonElement).disabled;
}

function tela() {
  return render(
    <AvisosProvider>
      <ListaEspera />
    </AvisosProvider>,
  );
}

beforeEach(() => {
  atualizar.mockClear();
  api = {
    adicionarEspera: vi.fn(),
    removerEspera: vi.fn(),
    devolverEspera: vi.fn(),
  };
});
afterEach(cleanup);

describe('ListaEspera: tirar da lista', () => {
  it('desabilita o botão e mostra "Tirando…" só no item pendente, e reabilita no fim', async () => {
    const d = adiada<ItemEspera | null>();
    vi.mocked(api.removerEspera).mockReturnValueOnce(d.promessa);
    tela();

    const [primeiro, segundo] = screen.getAllByRole('button', { name: 'Tirar da lista' });
    fireEvent.click(primeiro!);

    await waitFor(() => expect(desabilitado(screen.getByRole('button', { name: 'Tirando…' }))).toBe(true));
    expect(screen.getAllByRole('button', { name: 'Tirando…' })).toHaveLength(1);
    expect(desabilitado(segundo)).toBe(false);

    await act(async () => d.resolver(espera[0]!));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tirando…' })).toBeNull());
    expect(screen.getAllByRole('button', { name: 'Tirar da lista' })).toHaveLength(2);
    screen.getAllByRole('button', { name: 'Tirar da lista' }).forEach((b) => expect(desabilitado(b)).toBe(false));
  });

  it('duas remoções simultâneas: terminar uma não reabilita o botão da outra', async () => {
    const a = adiada<ItemEspera | null>();
    const b = adiada<ItemEspera | null>();
    vi.mocked(api.removerEspera).mockReturnValueOnce(a.promessa).mockReturnValueOnce(b.promessa);
    tela();

    const [primeiro, segundo] = screen.getAllByRole('button', { name: 'Tirar da lista' });
    fireEvent.click(primeiro!);
    fireEvent.click(segundo!);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Tirando…' })).toHaveLength(2));

    await act(async () => a.resolver(espera[0]!));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Tirando…' })).toHaveLength(1));
    const pendente = screen.getByRole('button', { name: 'Tirando…' });
    expect(desabilitado(pendente)).toBe(true);
    // O botão que terminou voltou ao normal; o outro continua travado.
    expect(desabilitado(screen.getByRole('button', { name: 'Tirar da lista' }))).toBe(false);

    await act(async () => b.resolver(espera[1]!));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tirando…' })).toBeNull());
  });

  it('mostra o erro de rede (TypeError) com a mensagem genérica e reabilita o botão', async () => {
    vi.mocked(api.removerEspera).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    tela();

    fireEvent.click(screen.getAllByRole('button', { name: 'Tirar da lista' })[0]!);

    expect((await screen.findByRole('alert')).textContent).toContain('Não deu certo. Tente de novo.');
    await waitFor(() => screen.getAllByRole('button', { name: 'Tirar da lista' }).forEach((b) => expect(desabilitado(b)).toBe(false)));
  });

  it('mostra a mensagem do ErroApi 401', async () => {
    vi.mocked(api.removerEspera).mockRejectedValueOnce(new ErroApi('Sessão expirada. Entre de novo.', 401));
    tela();

    fireEvent.click(screen.getAllByRole('button', { name: 'Tirar da lista' })[0]!);

    expect((await screen.findByRole('alert')).textContent).toContain('Sessão expirada. Entre de novo.');
  });

  it('"Tentar de novo" repete a remoção do mesmo item e passa pelo controle de pendência', async () => {
    const segunda = adiada<ItemEspera | null>();
    vi.mocked(api.removerEspera).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockReturnValueOnce(segunda.promessa);
    tela();

    fireEvent.click(screen.getAllByRole('button', { name: 'Tirar da lista' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar de novo' }));

    await waitFor(() => expect(api.removerEspera).toHaveBeenCalledTimes(2));
    expect(api.removerEspera).toHaveBeenNthCalledWith(1, 'e1');
    expect(api.removerEspera).toHaveBeenNthCalledWith(2, 'e1');
    // Enquanto a repetição está pendente o item volta a ficar travado.
    await waitFor(() => expect(desabilitado(screen.getByRole('button', { name: 'Tirando…' }))).toBe(true));

    await act(async () => segunda.resolver(espera[0]!));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tirando…' })).toBeNull());
  });
});

describe('ListaEspera: colocar na espera', () => {
  async function preencher() {
    fireEvent.change(screen.getByLabelText('Paciente'), { target: { value: 'Ana' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ana Souza' }));
  }

  it('mostra erro de rede e "Tentar de novo" chama a mesma operação de novo, com o botão travado enquanto pendente', async () => {
    const segunda = adiada<ItemEspera>();
    vi.mocked(api.adicionarEspera).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockReturnValueOnce(segunda.promessa);
    tela();
    await preencher();
    fireEvent.change(screen.getByLabelText(/Que horário serve/), { target: { value: 'terça de manhã' } });

    fireEvent.click(screen.getByRole('button', { name: 'Colocar na espera' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Não deu certo. Tente de novo.');

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(api.adicionarEspera).toHaveBeenCalledTimes(2));
    expect(api.adicionarEspera).toHaveBeenNthCalledWith(2, 'p1', 'terça de manhã');
    await waitFor(() => expect(desabilitado(screen.getByRole('button', { name: 'Colocando…' }))).toBe(true));

    await act(async () => segunda.resolver(espera[0]!));
    await waitFor(() => expect(desabilitado(screen.getByRole('button', { name: 'Colocar na espera' }))).toBe(false));
  });

  it('mostra a mensagem do ErroApi 401', async () => {
    vi.mocked(api.adicionarEspera).mockRejectedValueOnce(new ErroApi('Sessão expirada. Entre de novo.', 401));
    tela();
    await preencher();

    fireEvent.click(screen.getByRole('button', { name: 'Colocar na espera' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Sessão expirada. Entre de novo.');
  });
});
