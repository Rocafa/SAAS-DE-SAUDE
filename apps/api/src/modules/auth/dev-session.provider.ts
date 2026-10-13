import type { TenantId, UserId } from '@plataforma/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthContext, AuthProvider, RequisicaoParaSessao } from './auth-context';
import { ehPerfil, type Perfil } from './perfis';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;

/**
 * Sessão FICTÍCIA para desenvolvimento e teste, guardada em memória NO SERVIDOR. Imita o desenho
 * recomendado na D4: o cliente só tem um token opaco; clínica, usuário e perfis ficam do lado do
 * servidor. Recusa NODE_ENV=production (como o LocalKeyProvider).
 *
 * Não há login: as sessões são criadas por código (testes, script de dev). O mapa guarda o
 * SHA-256 do token, não o token.
 */
export class DevSessionProvider implements AuthProvider {
  readonly tipo = 'dev';
  private readonly sessoes = new Map<string, AuthContext>();

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') {
      throw new Error('DevSessionProvider é só para dev/teste: em produção use o provedor real (D4)');
    }
  }

  /** Cria uma sessão e devolve o token (vai no cabeçalho `Authorization: Bearer <token>`). */
  criarSessao(dados: { tenantId: string; userId: string; perfis: readonly string[] }): string {
    if (!UUID_RE.test(dados.tenantId) || !UUID_RE.test(dados.userId)) throw new Error('sessão fictícia inválida');
    if (dados.perfis.length === 0 || !dados.perfis.every(ehPerfil)) throw new Error('perfil inválido');
    const token = randomBytes(32).toString('base64url');
    this.sessoes.set(
      hash(token),
      Object.freeze({
        tenantId: dados.tenantId.toLowerCase() as TenantId,
        userId: dados.userId.toLowerCase() as UserId,
        perfis: Object.freeze([...new Set(dados.perfis as Perfil[])]),
      }),
    );
    return token;
  }

  /** Logout: a sessão morre no servidor e o token antigo passa a receber 401. */
  encerrarSessao(token: string): void {
    this.sessoes.delete(hash(token));
  }

  resolver(req: RequisicaoParaSessao): Promise<AuthContext | null> {
    const cabecalho = req.headers.authorization;
    if (typeof cabecalho !== 'string') return Promise.resolve(null);
    const m = TOKEN_RE.exec(cabecalho);
    if (!m?.[1]) return Promise.resolve(null);
    return Promise.resolve(this.sessoes.get(hash(m[1])) ?? null);
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
