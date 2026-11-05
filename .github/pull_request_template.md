## O que muda
<!-- descreva a microparte (ID da WBS) -->

## Frente
- [ ] Mercado  - [ ] Produto  - [ ] Engenharia  - [ ] IA/LLM  - [ ] LGPD

## Gate LGPD & Segurança (obrigatório)
- [ ] Não há dado real de paciente (código, seed, teste, log, prompt, dataset)
- [ ] Não há segredo/token/certificado no diff
- [ ] Queries respeitam isolamento por tenant
- [ ] Acesso a prontuário gera log de auditoria
- [ ] Base legal identificada para qualquer novo tratamento de dado
- [ ] Logs sem dado pessoal: nada de nome, CPF, telefone, e-mail, conteúdo clínico ou mensagem de erro em `Logger`/`console`; evento de segurança novo entra no catálogo de `security/log-de-seguranca.ts` (a trava `logs-sem-dado-pessoal.test.ts` reprova o resto)
- [ ] Itens 🔴 do [checklist de PR](../docs/03-seguranca-lgpd/checklist-pr.md) conferidos (IA, suboperador, criptografia de campo, logs)
- [ ] Revisado pelo agente `guardiao-lgpd`: APROVADO (link do parecer em `docs/03-seguranca-lgpd/revisoes/`)

## Evidência de teste
<!-- comandos rodados e resultado: tsc, vitest, eslint; testes RLS/E2E no CI -->

## Aprovação dos sócios
- [ ] Sócio 1  - [ ] Sócio 2
