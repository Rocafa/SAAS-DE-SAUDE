# Estado da frente LGPD — rodada 8 (2026-10-11)

Branch: `lgpd/mapa-regulatorio-e-retencao` · Worktree: `../saude-r8-lgpd`
Agente: `guardiao-lgpd` (N1, poder de veto) · Escopo: `docs/03-seguranca-lgpd/**` e `docs/relatorios/**`

## Feito

| # | Entrega | Onde | Commit |
|---|---|---|---|
| 1 | Parecer formal do **PR #29** (módulo de IA) — aprovado com ressalvas + veto prévio V1–V5 | `docs/03-seguranca-lgpd/revisoes/2026-10-11-pr29.md` e comentário no PR | `dfac822` |
| 1 | Parecer formal do **PR #30** (rate limit com hash de IP) — aprovado com ressalvas | `docs/03-seguranca-lgpd/revisoes/2026-10-11-pr30.md` e comentário no PR | `dfac822` |
| 2 | Mapa regulatório atualizado (dívida da §7 da rodada 7) | `docs/03-seguranca-lgpd/README.md` | `77fe6ae` |
| 2 | Linha do contador de rate limit no ROPA | `docs/03-seguranca-lgpd/bases-legais-e-consentimento.md` | `77fe6ae` |
| 3 | **J13** — matriz de retenção por conselho e tipo de registro, com requisito RT-RET-01 | `docs/03-seguranca-lgpd/matriz-retencao.md` | `19e9b4e` |
| 4 | RIPD da IA assistiva (escriba) — rascunho ⚖️ | `docs/03-seguranca-lgpd/RIPD-ia-escriba.md` | `f66189a` |
| 4 | RIPD do WhatsApp — rascunho ⚖️ | `docs/03-seguranca-lgpd/RIPD-whatsapp.md` | `f66189a` |
| Vigília | Parecer do **PR #35** (criptografia de campo por clínica) — aprovado com ressalvas | `docs/03-seguranca-lgpd/revisoes/2026-10-11-pr35.md` e comentário no PR | este |
| Vigília | Parecer do **PR #37** (auditoria encadeada) — aprovado com ressalvas | `docs/03-seguranca-lgpd/revisoes/2026-10-11-pr37.md` e comentário no PR | este |

Normas lidas no **texto oficial** nesta rodada: CFM 2.454/2026, CFM 2.299/2021, Lei 13.787/2018, Lei 15.352/2026, CFP 001/2009, COFFITO 414/2012, CFO-SEC-91/2009, CFN 594/2017. Em fonte secundária, sinalizado no documento: CFFa 777/2025, RDC Anvisa 1.000/2025 e 1.028/2026, LC 214/2025, Receita Saúde, Agenda Regulatória Anvisa 2026–2027.

## Falta

- Revisar o **PR #34** (`qa/guarda-de-schema`) e o **PR #36** (PoC da D4) — são da aba QA, fora do escopo literal da ordem (ENG e DEVOPS), mas o #34 cobra RLS e policy no CI e o #36 decide autenticação: os dois tocam o meu mandato.
- Nenhum PR da aba DEVOPS abriu até agora. O #35 e o #37 deixaram três itens 22 🔴 pendentes para ela: Redis com rede privada e criptografia, KMS em `sa-east-1` com CMK por clínica, e S3 com Object Lock para a âncora da auditoria.
- Atualizar, na próxima rodada, os três lugares que o PR #35 muda: `RIPD-ia-escriba.md` §5, a linha de C4 em `requisitos-tecnicos-seguranca.md` e `matriz-retencao.md` §4.
- Conciliar `retencao-e-descarte.md` (PR #28) com a matriz, se o #28 entrar primeiro.

## Próximo passo

Seguir a vigília (`gh pr list` a cada ~20 min) e revisar o #34 e o #36 se o Maestro confirmar que entram no meu escopo.

## Último commit

Ver `git log` do branch. PR da frente: **#38**. Pareceres publicados nos PRs #29, #30, #35 e #37, e comentário de divergência no #28.
