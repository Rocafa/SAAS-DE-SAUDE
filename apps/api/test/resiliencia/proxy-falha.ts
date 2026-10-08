/**
 * Proxy TCP de injeção de falha entre a API e o Postgres real.
 * - `parar()`: derruba todas as conexões abertas e passa a RECUSAR novas (como banco parado /
 *   instância RDS reiniciando: o cliente vê ECONNRESET/ECONNREFUSED);
 * - `buracoNegro()`: aceita TCP mas nunca encaminha (rede particionada: só o timeout salva);
 * - `voltar()`: volta a encaminhar normalmente, sem reiniciar a API.
 * Usar proxy (em vez de parar o serviço) deixa o teste idêntico local e no CI.
 */
import net from 'node:net';

export type ModoProxy = 'normal' | 'parado' | 'buraco-negro';

export interface ProxyFalha {
  readonly port: number;
  parar(): Promise<void>;
  buracoNegro(): void;
  voltar(): Promise<void>;
  fechar(): Promise<void>;
  /** Substitui host:porta de uma URL de banco pelo proxy. */
  urlVia(url: string): string;
}

export async function criarProxyFalha(alvo: { host: string; port: number }): Promise<ProxyFalha> {
  let modo: ModoProxy = 'normal';
  const sockets = new Set<net.Socket>();

  const onConnection = (cliente: net.Socket): void => {
    sockets.add(cliente);
    cliente.on('close', () => sockets.delete(cliente));
    cliente.on('error', () => undefined);
    if (modo === 'buraco-negro') return; // segura o socket sem responder
    const servidor = net.connect(alvo.port, alvo.host);
    sockets.add(servidor);
    servidor.on('close', () => {
      sockets.delete(servidor);
      cliente.destroy();
    });
    servidor.on('error', () => cliente.destroy());
    cliente.on('close', () => servidor.destroy());
    cliente.pipe(servidor).pipe(cliente);
  };

  let server = net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const destruirTudo = (): void => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };

  const fecharServidor = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return {
    port,
    async parar() {
      modo = 'parado';
      destruirTudo();
      if (server.listening) await fecharServidor(); // porta fechada => ECONNREFUSED
    },
    buracoNegro() {
      modo = 'buraco-negro';
      destruirTudo();
    },
    async voltar() {
      destruirTudo();
      modo = 'normal';
      if (!server.listening) {
        server = net.createServer(onConnection);
        await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      }
    },
    async fechar() {
      destruirTudo();
      if (server.listening) await fecharServidor();
    },
    urlVia(url: string) {
      const u = new URL(url);
      u.hostname = '127.0.0.1';
      u.port = String(port);
      return u.toString();
    },
  };
}

/** host/porta do Postgres real a partir da URL. */
export function alvoDe(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname, port: Number(u.port || 5432) };
}
