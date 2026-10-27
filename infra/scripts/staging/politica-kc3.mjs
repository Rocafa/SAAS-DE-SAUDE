#!/usr/bin/env node
// Gera a key policy da chave de uma clínica EXATAMENTE como a API gera (K-c3 de integração).
//
// Origem: `politicaDaChaveDaClinica(contaAws, tenantId, papeisHumanosExtra)` em
// apps/api/src/modules/crypto/kms-key-provider.ts (branch eng/integracao-r19, PR #73, K-c2; R4 do
// #58 a partir de 15e3303: statement HumanoNaoDecifra com os padrões fixos + extras).
//
// Sem build: lê o arquivo .ts, separa pela AST do TypeScript só as declarações de que a função
// depende (OPERACOES_DE_DADOS, CONDICAO_TENANT, validarConta, papeisHumanosExtraDoAmbiente e a
// própria função), tira os tipos
// com `ts.transpileModule` e executa num `vm` isolado. Assim a prova usa o código da API, não uma
// cópia: se a função mudar, a política da prova muda junto. Se aparecer uma dependência nova que
// não está na lista, o vm falha (ReferenceError) e a prova para, em vez de usar política errada.
//
// Uso: node politica-kc3.mjs <conta-aws-12-digitos> <tenant-uuid> [extras]
//   extras           padrões de ARN de humanos além dos fixos, separados por vírgula (mesmo formato
//                    de KMS_PAPEIS_HUMANOS_EXTRA). Sem o 3º argumento, usa a variável
//                    KMS_PAPEIS_HUMANOS_EXTRA. A lista é lida e validada pelo código da API
//                    (papeisHumanosExtraDoAmbiente + politicaDaChaveDaClinica): formato errado para aqui.
//   KMS_PROVIDER_TS  caminho do kms-key-provider.ts (padrão: <raiz do repo>/apps/api/src/...)
// Precisa do pacote `typescript` instalado (pnpm install na raiz do repositório).
// O .ts tem de estar versionado num checkout git limpo: a origem traz o commit (git rev-parse HEAD).
// Saída (stdout): JSON { politica, papeis_humanos_extra, origem: { arquivo, sha256, commit,
// commit_na_origin_main } }. Nada de dado pessoal.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const [conta, tenant, extrasArg] = process.argv.slice(2);
const extrasBrutos = extrasArg ?? process.env.KMS_PAPEIS_HUMANOS_EXTRA;
if (!conta || !tenant) {
  console.error('uso: node politica-kc3.mjs <conta-aws> <tenant-uuid> [extras separados por vírgula]');
  process.exit(2);
}

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '..', '..', '..');
const arquivo = path.resolve(
  process.env.KMS_PROVIDER_TS ?? path.join(raiz, 'apps/api/src/modules/crypto/kms-key-provider.ts'),
);
if (!existsSync(arquivo)) {
  console.error(`politica-kc3: não achei ${arquivo} (rode de um checkout com o código da API do #73)`);
  process.exit(3);
}

// Procura o typescript perto do arquivo, na raiz do repo e no diretório atual.
let ts;
for (const base of [arquivo, path.join(raiz, 'package.json'), path.join(process.cwd(), 'package.json')]) {
  try {
    ts = createRequire(base)('typescript');
    break;
  } catch {
    /* tenta o próximo */
  }
}
if (!ts) {
  console.error('politica-kc3: pacote typescript não encontrado (rode pnpm install na raiz)');
  process.exit(4);
}

// Commit de onde sai o .ts (condição 2 da conferência de 27/10): o arquivo tem de estar versionado
// num checkout git LIMPO (nenhuma mudança em arquivo versionado), senão o SHA não descreve o que
// rodou. Arquivo não versionado também é recusado.
const git = (...args) =>
  execFileSync('git', ['-C', path.dirname(arquivo), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let commit;
let naMain = null;
try {
  git('ls-files', '--error-unmatch', '--', path.basename(arquivo));
  const sujo = git('status', '--porcelain', '--untracked-files=no');
  if (sujo) {
    console.error(`politica-kc3: o checkout de ${arquivo} está sujo (mudanças não commitadas); recusado:\n${sujo}`);
    process.exit(8);
  }
  commit = git('rev-parse', 'HEAD');
  try {
    git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
    naMain = true;
  } catch {
    naMain = false;
  }
} catch (e) {
  console.error(`politica-kc3: ${arquivo} não está num checkout git versionado (${e.message.split('\n')[0]}); recusado`);
  process.exit(8);
}

const fonte = readFileSync(arquivo, 'utf8');
const sha256 = createHash('sha256').update(fonte).digest('hex');
const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.ES2022, true);

const NOMES = new Set([
  'OPERACOES_DE_DADOS',
  'CONDICAO_TENANT',
  'validarConta',
  'papeisHumanosExtraDoAmbiente',
  'politicaDaChaveDaClinica',
]);
const trechos = [];
const achados = new Set();
for (const st of sf.statements) {
  if (ts.isFunctionDeclaration(st) && st.name && NOMES.has(st.name.text)) {
    achados.add(st.name.text);
    // `export` sai: o vm roda como script.
    trechos.push(st.getText(sf).replace(/^export\s+/, ''));
  } else if (ts.isVariableStatement(st)) {
    const nomes = st.declarationList.declarations.map((d) => d.name.getText(sf));
    if (nomes.some((n) => NOMES.has(n))) {
      nomes.forEach((n) => achados.add(n));
      trechos.push(st.getText(sf).replace(/^export\s+/, ''));
    }
  }
}
const faltando = [...NOMES].filter((n) => !achados.has(n));
if (faltando.length) {
  console.error(`politica-kc3: declarações não encontradas em ${arquivo}: ${faltando.join(', ')}`);
  process.exit(5);
}

const js = ts.transpileModule(trechos.join('\n\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const contexto = vm.createContext({});
vm.runInContext(
  `${js}\nglobalThis.__politica = politicaDaChaveDaClinica;\nglobalThis.__extras = papeisHumanosExtraDoAmbiente;`,
  contexto,
  { timeout: 1000 },
);
let extras;
let politica;
try {
  // Array do vm vem de outro realm: copia para um array daqui antes de devolver à função.
  extras = [...contexto.__extras(extrasBrutos)];
  politica = contexto.__politica(conta, tenant, extras);
} catch (e) {
  console.error(`politica-kc3: a API recusou os parâmetros: ${e.message}`);
  process.exit(7);
}

// Confere a forma mínima esperada (K-c2), para não provar outra coisa sem perceber.
const p = JSON.parse(politica);
const sids = p.Statement.map((s) => s.Sid);
for (const sid of [
  'Enable IAM User Permissions',
  'NegarSemContextoDaClinica',
  'NegarContextoDeOutraClinica',
  'HumanoNaoDecifra',
]) {
  if (!sids.includes(sid)) {
    console.error(`politica-kc3: statement ${sid} ausente na política gerada`);
    process.exit(6);
  }
}

// R4: todo extra pedido está no ArnLike do HumanoNaoDecifra.
const humanos = p.Statement.find((s) => s.Sid === 'HumanoNaoDecifra').Condition?.ArnLike?.['aws:PrincipalArn'] ?? [];
const semExtra = extras.filter((x) => !humanos.includes(x));
if (semExtra.length) {
  console.error(`politica-kc3: extras fora do HumanoNaoDecifra: ${semExtra.join(', ')}`);
  process.exit(6);
}

process.stdout.write(
  JSON.stringify({ politica, papeis_humanos_extra: extras, origem: {
    arquivo: path.relative(raiz, arquivo).split(path.sep).join('/'),
    sha256,
    commit,
    // Informativo: o commit já está na origin/main local (depende do último fetch).
    commit_na_origin_main: naMain,
  } }),
);
