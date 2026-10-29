// Canary do CloudWatch Synthetics (jobs-ready.tf, R3 do parecer de jobs, infra-staging.md §4.4).
// Lê o /health/ready da API pelo ALB e falha se o campo `jobs` não for "bullmq".
// O corpo do /health/ready só tem rótulos fixos ({status, rateLimit, jobs}); nada de dado pessoal.
// Fonte do pacote canary/jobs-ready.zip (nodejs/node_modules/index.js); o CI confere que são iguais.
'use strict';

const https = require('https');

// Rótulos conhecidos do modo do agendador (apps/api/src/modules/jobs/estado-dos-jobs.ts).
const ROTULOS = ['bullmq', 'nao_iniciado', 'desligado', 'memoria'];

// Valida o certificado por padrão; só VALIDAR_CERTIFICADO=false desliga. O staging liga a exceção
// em jobs-ready.tf enquanto não houver domínio (I10): o certificado do ALB é do domínio e a URL usa
// o DNS do ALB. O CI (infra.yml, job tls) reprova a exceção fora de infra/terraform/staging/.
const VALIDAR_CERTIFICADO = process.env.VALIDAR_CERTIFICADO !== 'false';

function lerCorpo(url) {
  return new Promise((ok, falha) => {
    const req = https.get(
      url,
      { rejectUnauthorized: VALIDAR_CERTIFICADO, timeout: 10000, headers: { 'user-agent': 'canary-jobs-ready' } },
      (res) => {
        let corpo = '';
        res.setEncoding('utf8');
        res.on('data', (parte) => {
          corpo += parte;
          if (corpo.length > 4096) req.destroy(new Error('corpo_grande'));
        });
        res.on('end', () => ok(corpo));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => falha(new Error(`requisicao_falhou:${err.code || err.message}`)));
  });
}

exports.handler = async () => {
  const corpo = await lerCorpo(process.env.URL_READY);
  let jobs;
  try {
    // 200 ou 503 (banco fora): o campo jobs vem nos dois casos.
    jobs = JSON.parse(corpo).jobs;
  } catch {
    throw new Error('corpo_invalido');
  }
  if (jobs !== 'bullmq') {
    throw new Error(`jobs=${ROTULOS.includes(jobs) ? jobs : 'outro'}`);
  }
  return 'jobs=bullmq';
};
