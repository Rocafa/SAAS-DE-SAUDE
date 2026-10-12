// Teste de carga k6 — liveness (/health) e readiness (/health/ready, que toca o banco).
// Sem dados de paciente: só endpoints de saúde. Rodar contra API local/CI, NUNCA contra produção.
//
//   k6 run -e BASE_URL=http://127.0.0.1:3333 tests/carga/health.k6.js
//   k6 run -e BASE_URL=... -e PERFIL=smoke tests/carga/health.k6.js   (só o smoke)
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3333';
const PERFIL = __ENV.PERFIL || 'completo';

const smoke = {
  executor: 'constant-vus',
  vus: 1,
  duration: '15s',
  tags: { cenario: 'smoke' },
};

// Carga moderada: rampa até 50 req/s, sustenta 1 min, desce. Ordem de grandeza de uma instância
// atendendo dezenas de clínicas em horário de pico (ESTIMATIVA, não medição de produção).
const moderada = {
  executor: 'ramping-arrival-rate',
  startRate: 5,
  timeUnit: '1s',
  preAllocatedVUs: 20,
  maxVUs: 100,
  stages: [
    { target: 50, duration: '30s' },
    { target: 50, duration: '1m' },
    { target: 0, duration: '15s' },
  ],
  startTime: '15s',
  tags: { cenario: 'moderada' },
};

export const options = {
  scenarios: PERFIL === 'smoke' ? { smoke } : { smoke, moderada },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:liveness}': ['p(95)<300'],
    'http_req_duration{endpoint:readiness}': ['p(95)<300'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const live = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'liveness' } });
  check(live, {
    'liveness 200': (r) => r.status === 200,
    'liveness sem detalhes': (r) => r.body === '{"status":"ok"}',
  });

  const ready = http.get(`${BASE_URL}/health/ready`, { tags: { endpoint: 'readiness' } });
  check(ready, {
    'readiness 200': (r) => r.status === 200,
    // Só `status` e o rótulo do modo do rate limit (R4 do Guardião no #30) — nenhum detalhe de erro.
    'readiness sem detalhes': (r) => READINESS_OK.test(r.body),
  });
}

const READINESS_OK = /^\{"status":"ok","rateLimit":"(compartilhado|fallback|memoria|instancia-unica|desligado)"\}$/;
