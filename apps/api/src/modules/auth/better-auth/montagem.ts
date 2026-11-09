/**
 * Montagem HTTP do Better Auth (D4), fora de controller Nest: declarada em `HANDLERS_FORA_DE_CONTROLLER` (R6 do
 * parecer do #117). Uma camada NOSSA na frente do handler da biblioteca:
 * - R4 do parecer do desenho: lista FECHADA de endpoints; o resto dá 404 (cadastro, troca de e-mail, exclusão…).
 * - R10: o cabeçalho de origem do cliente é apagado e preenchido com o NOSSO HMAC do IP (a biblioteca grava esse
 *   valor na sessão e nunca vê o IP).
 * - R1 do parecer do #132: escrita sem `Origin` (cookie de sessão + navegador sem origem) dá 403; a origem fora da
 *   allowlist já foi barrada pelo `protecaoCsrf` da borda.
 * - R3: sessão com mais de 12 h é apagada e recusada também nos endpoints da biblioteca.
 * - Log de segurança: login recusado e logout (o login aceito sai pelo gancho de banco da instância, com o usuário).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { origemDaRequisicao, registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { CABECALHO_ORIGEM, PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';
import type { BetterAuthProvider } from './provedor';

export const PREFIXO = '/api/auth';
/** Login é e-mail e senha: 4 KiB bastam. Corpo maior ou sem tamanho declarado (chunked) dá 413. */
export const TETO_DO_CORPO = 4 * 1024;

/** Endpoints da biblioteca expostos (método + caminho depois do prefixo). O PR 2 acrescenta o TOTP. */
export const ENDPOINTS_PERMITIDOS: ReadonlySet<string> = new Set(['POST /sign-in/email', 'POST /sign-out', 'GET /get-session']);

type Req = IncomingMessage & { ip?: string };
type Next = (err?: unknown) => void;

function responder(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, message }));
}

export function montarAutenticacao(auth: Autenticacao, provedor: BetterAuthProvider, agora: () => number = Date.now) {
  const handler = toNodeHandler(auth);
  return (req: Req, res: ServerResponse, next: Next): void => {
    const url = req.url ?? '';
    if (url !== PREFIXO && !url.startsWith(`${PREFIXO}/`) && !url.startsWith(`${PREFIXO}?`)) {
      next();
      return;
    }
    const metodo = (req.method ?? 'GET').toUpperCase();
    const caminho = (url.split('?')[0] ?? '').slice(PREFIXO.length) || '/';
    const rota = `${metodo} ${caminho}`;
    if (!ENDPOINTS_PERMITIDOS.has(rota)) {
      responder(res, 404, 'Not Found');
      return;
    }
    // A biblioteca lê o corpo cru, antes do parser JSON da borda: limite próprio (ressalva do parecer do código).
    if (Number(req.headers['content-length'] ?? '0') > TETO_DO_CORPO || req.headers['transfer-encoding'] !== undefined) {
      responder(res, 413, 'Payload Too Large');
      return;
    }
    const origem = origemDaRequisicao(req.ip ?? req.socket.remoteAddress);
    delete req.headers[CABECALHO_ORIGEM];
    if (origem) req.headers[CABECALHO_ORIGEM] = origem;
    if (metodo === 'POST' && typeof req.headers.origin !== 'string') {
      registrarEventoDeSeguranca('CSRF_RECUSADO', { motivo: 'origem_nao_permitida', ...(origem ? { origem } : {}) });
      responder(res, 403, 'Forbidden');
      return;
    }
    void (async () => {
      let sessaoEncerrada = false;
      if (rota !== 'POST /sign-in/email') {
        // R3: prazo absoluto também nos endpoints da biblioteca (a sessão vencida é apagada).
        const lida = await auth.api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableRefresh: true } }).catch(() => null);
        if (lida && agora() - new Date(lida.session.createdAt).getTime() > PRAZO_ABSOLUTO_MS) {
          await provedor.encerrar(lida.session.id, 'prazo_absoluto', lida.user.id);
          responder(res, 401, 'Unauthorized');
          return;
        }
        // R6(a) do #117: o "sair" passa pelo provedor, que lê a clínica ativa, apaga a sessão e grava `session_ended`
        // na trilha (e o LOGOUT no log). A biblioteca roda depois só para apagar o cookie no navegador.
        if (rota === 'POST /sign-out' && lida) {
          await provedor.encerrar(lida.session.id, 'logout', lida.user.id);
          sessaoEncerrada = true;
        }
      }
      res.on('finish', () => {
        if (rota === 'POST /sign-in/email' && res.statusCode !== 200) {
          registrarEventoDeSeguranca('LOGIN_FALHOU', { motivo: 'senha_errada', status: res.statusCode, ...(origem ? { origem } : {}) });
        }
        // Com sessão, o LOGOUT já saiu pelo provedor (com o usuário); aqui só o "sair" sem sessão do provedor.
        if (rota === 'POST /sign-out' && res.statusCode === 200 && !sessaoEncerrada) {
          registrarEventoDeSeguranca('LOGOUT', { motivo: 'logout', ...(origem ? { origem } : {}) });
        }
      });
      await handler(req, res);
    })().catch(next);
  };
}
