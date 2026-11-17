# Parecer do Guardião — PR #139 (`eng/origem-no-portal`)

**Data:** 05/11/2026 · **Escopo:** `portal.controller.ts`, `portal.service.ts`, `emissao-de-eventos.test.ts`, `docs/00-governanca/fila.md` (R7 do #129; R5 do #130).

## Veredito: **APROVADO** (com ressalvas não bloqueantes)

## O que foi conferido

- **IP não vaza.** O controller só repassa `origemDaRequisicao(http.ip)`: HMAC-SHA256 (chave `RATE_LIMIT_HASH_KEY`, prefixo `log:`) truncado a 16 hex; sem chave, devolve `undefined` (nunca o IP). O serviço recebe só a `origem`, e o `PORTAL_RESGATE_RECUSADO` leva `{ origem }` nos dois ramos (sem telefone; vínculo não encontrado). O token, o código e o `contaId` não entram no evento. O teste confere que o IP não aparece nos argumentos passados ao serviço.
- **`req.ip` x trust proxy.** `http-security.ts` só faz `set('trust proxy', N)` com `HTTP_TRUST_PROXY_HOPS > 0` (padrão 0). Com 0, `req.ip` é o endereço do socket e o `X-Forwarded-For` é ignorado: o cliente não consegue forjar a origem. O valor é o mesmo do rate limit e do guard, então os eventos se correlacionam.
- **R5 do #130, importação.** A afirmação procede no essencial. Na 0024 (e nas 0026/0048), o banco exige admin **ativo** (`app_user_has_role` → `clinic_members.revoked_at IS NULL`, 0020) quando o lote é criado, aplicado (`recebido/simulado → aplicado`) e desfeito (trigger e `app_undo_import_batch`, SECURITY DEFINER). O `aplicar` roda numa transação só, e o `UPDATE … status='aplicado'` é a **última** escrita. Em READ COMMITTED, essa escrita lê o perfil em vigor ao fim da operação longa; sem ele, tudo volta (42501). A exportação total ainda não tem rota: adiar para a G2 é aceitável.

## Ressalvas

1. **Texto da fila, precisão.** "Conferida pelo banco **a cada etapa**" exagera. Mapear, validar e simular (`→ validado/simulado`, gravação de `import_issues` e do `simulation_hash`) **não** voltam a conferir o perfil no banco; só criar, aplicar e desfazer. O risco é baixo, porque nada clínico é gravado e o aplicar confere de novo. Ainda assim, corrija para "criar, aplicar e desfazer".
2. **Janela residual no aplicar.** Uma revogação gravada depois do `UPDATE` final e antes do COMMIT não barra o lote. Para operação de admin, o risco é aceitável. Registre na fila como risco aceito, para não ser lido como garantia absoluta.
3. **Deploy: `HTTP_TRUST_PROXY_HOPS`.** Atrás do ALB, com 0, todo `req.ip` vira o IP do balanceador, e a `origem` deixa de distinguir clientes. Não há vazamento, mas o log perde utilidade forense e o rate limit por IP vira global. Ao lado da R5 do #129 (ALB), o checklist de produção deve exigir o valor exato de saltos, nunca `true`.
4. **Teste pode passar vazio.** Sem chave, as duas `origem` saem `undefined` e o `toBe` passa assim mesmo. Acrescente `expect(chamadas[0]?.at(-1)).toMatch(/^[0-9a-f]{16}$/)`. Acrescente também um caso no serviço que confira `PORTAL_RESGATE_RECUSADO` com `origem` emitido (hoje só o repasse do controller é testado).
5. **Pendência mantida.** A `origem` nos alertas da vigilância do portal continua aberta (a fila já registra). Feche antes do piloto.

Não houve execução de testes de RLS (sem Postgres local). As conclusões sobre a 0024 vêm da leitura do SQL e do `importacao.service.ts`.

## Nota do Maestro (05/11/2026)

- **R1 (feita):** o texto da fila foi corrigido. Só criar, aplicar e desfazer reconferem o perfil no banco; mapear, validar e simular não gravam paciente.
- **R2 (registrada como risco aceito na fila):** a janela entre a gravação final do status do `aplicar` e o COMMIT.
- **R3 (na fila de produção):** `HTTP_TRUST_PROXY_HOPS` exato, conferido no staging.
- **R4 (feita):** o teste exige o formato hex de 16 caracteres antes de comparar.
- **R5 (fila):** a origem nos alertas da vigilância do portal.
