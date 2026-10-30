/**
 * Mede, por HTTP, os critérios da decisão D4 contra a PoC do Better Auth no ar.
 * Só dados sintéticos. Imprime uma linha por critério, com o valor OBSERVADO.
 *
 * Uso: POC_BASE_URL=http://localhost:8085 node medir.mjs
 */
const base = process.env.POC_BASE_URL ?? 'http://localhost:8085';
const marca = Date.now();
const email = `ficticio-${marca}@poc.localhost`;
const senha = 'Senha-Sintetica-1!';
const cookies = new Map();
const cookieAtual = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

/** Guarda os cookies por NOME: um Set-Cookie novo não apaga os outros. */
const guardaCookie = (res) => {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const bruto of set) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    cookies.set(par.slice(0, i), par.slice(i + 1));
  }
  return set;
};

async function chamar(caminho, { metodo = 'POST', corpo, extra = {} } = {}) {
  const res = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', origin: base, ...(cookies.size ? { cookie: cookieAtual() } : {}), ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const set = guardaCookie(res);
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return { status: res.status, json, set };
}

const linha = (criterio, valor) => console.log(`${criterio}\t${valor}`);

// 0. CSRF: escrita sem cabeçalho Origin é recusada?
const semOrigin = await fetch(`${base}/api/auth/sign-up/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `sem-origin-${marca}@poc.localhost`, password: senha, name: 'X' }),
});
linha('CSRF: POST sem Origin', semOrigin.status === 403 ? 'RECUSADO (403)' : `aceito (${semOrigin.status})`);

// 1. Cadastro e atributos do cookie de sessão
const cadastro = await chamar('/api/auth/sign-up/email', {
  corpo: { email, password: senha, name: 'Usuario Ficticio' },
});
const cookieSessao = cadastro.set.find((c) => c.startsWith('better-auth.session_token')) ?? '';
linha('cookie: HttpOnly', /HttpOnly/i.test(cookieSessao) ? 'SIM' : 'NAO');
linha('cookie: SameSite', (/SameSite=(\w+)/i.exec(cookieSessao) ?? [, 'ausente'])[1]);
linha('cookie: Secure', /Secure/i.test(cookieSessao) ? 'SIM' : 'NAO (PoC em http)');
linha('cookie: Path', (/Path=([^;]+)/i.exec(cookieSessao) ?? [, 'ausente'])[1]);

// 2. Access token curto (plugin jwt)
const token = await chamar('/api/auth/token', { metodo: 'GET' });
let vidaToken = 'nao obtido';
if (token.json?.token) {
  const [, payload] = token.json.token.split('.');
  const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
  vidaToken = `${p.exp - p.iat}s`;
}
linha('access token: validade', vidaToken);

// 3. MFA TOTP e WebAuthn
const totp = await chamar('/api/auth/two-factor/enable', { corpo: { password: senha } });
linha('MFA TOTP: URI emitida', totp.json?.totpURI ? 'SIM' : `NAO (HTTP ${totp.status})`);
const passkey = await chamar('/api/auth/passkey/generate-register-options', { metodo: 'GET' });
linha('MFA WebAuthn: desafio emitido', passkey.json?.challenge ? 'SIM' : `NAO (HTTP ${passkey.status})`);

// 4. Usuário em várias clínicas
const c1 = await chamar('/api/auth/organization/create', {
  corpo: { name: 'Clinica Ficticia A', slug: `clinica-a-${marca}` },
});
const c2 = await chamar('/api/auth/organization/create', {
  corpo: { name: 'Clinica Ficticia B', slug: `clinica-b-${marca}` },
});
const lista = await chamar('/api/auth/organization/list', { metodo: 'GET' });
linha('usuario em varias clinicas', Array.isArray(lista.json) ? `${lista.json.length} clinicas` : 'NAO');

// 5. Troca de clínica e tenant vindo do servidor, não do cliente
await chamar('/api/auth/organization/set-active', { corpo: { organizationId: c1.json?.id } });
const w1 = await chamar('/whoami', { metodo: 'GET', extra: { 'x-tenant-id': c2.json?.id ?? 'mentira' } });
linha('troca de clinica', w1.json?.clinicaAtiva === c1.json?.id ? 'SIM' : 'NAO');
linha(
  'tenant ignora o que o cliente manda',
  w1.json?.clinicaAtiva === c1.json?.id && w1.json?.clinicaQueOClienteAlegou !== w1.json?.clinicaAtiva
    ? 'SIM (usou a sessao)'
    : 'NAO',
);
await chamar('/api/auth/organization/set-active', { corpo: { organizationId: c2.json?.id } });
const w2 = await chamar('/whoami', { metodo: 'GET' });
linha('troca efetiva para a 2a clinica', w2.json?.clinicaAtiva === c2.json?.id ? 'SIM' : 'NAO');

// 6. Recuperação de conta sem revelar existência
const guardado = cookieAtual();
const copia = new Map(cookies);
cookies.clear();
const existe = await chamar('/api/auth/request-password-reset', { corpo: { email, redirectTo: '/' } });
const naoExiste = await chamar('/api/auth/request-password-reset', {
  corpo: { email: `inexistente-${marca}@poc.localhost`, redirectTo: '/' },
});
linha(
  'recuperacao nao revela existencia',
  existe.status === naoExiste.status && JSON.stringify(existe.json) === JSON.stringify(naoExiste.json)
    ? `SIM (ambos HTTP ${existe.status}, mesmo corpo)`
    : `NAO (${existe.status} vs ${naoExiste.status})`,
);
cookies.clear();
for (const [k, v] of copia) cookies.set(k, v);

// 7. Logout global
const antes = await chamar('/whoami', { metodo: 'GET' });
await chamar('/api/auth/sign-out', { corpo: {} });
const depois = await chamar('/whoami', { metodo: 'GET', extra: { cookie: guardado } });
linha(
  'logout global',
  antes.status === 200 && depois.status === 401 ? 'SIM (sessao morreu no servidor)' : `parcial (${depois.status})`,
);
