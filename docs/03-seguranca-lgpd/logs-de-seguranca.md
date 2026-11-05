# Logs de segurança

> Atualizado em 04/11/2026. Código: `apps/api/src/security/log-de-seguranca.ts`. Trava de PR: `apps/api/src/security/logs-sem-dado-pessoal.test.ts`.

## 1. Três registros, três papéis

| Registro | Para quê | Onde | Quem lê |
|---|---|---|---|
| **Trilha de auditoria** (`audit_log`) | **Prova**: quem fez o quê, em qual clínica, encadeada por hash | Postgres, por clínica (RLS), vai no pacote da G2 | Clínica (controladora), DPO, perícia |
| **Log de segurança** (este documento) | **Detectar e alarmar** em tempo real, inclusive quando a trilha não gravou | CloudWatch Logs (linha JSON `tipo: "seguranca"`) | Operador da plataforma, plantão |
| **Log operacional** (jobs, KMS, Redis, shutdown) | Saúde do sistema | CloudWatch Logs (texto com código fixo, ex.: `JOB_FALHOU`) | Operador |

O log de segurança **não substitui** a trilha. Um acesso negado, por exemplo, vai para os dois: a trilha guarda a prova da clínica, e o log dispara o alarme.

## 2. Regras (LGPD arts. 6 III, 46 e 48)

1. **Catálogo fechado:** só eventos de `EVENTOS_DE_SEGURANCA`, cada um com severidade e tipo de alarme.
2. **Campos fechados e validados:**
   - `tenantId` e `userId`: UUID.
   - `rota`: método + **template** da rota, vindo do framework, com segmentos fixos sem dígito ou `:param`.
   - `handler`: `XController.metodo`.
   - `motivo` e `regra`: **listas fechadas** `MOTIVOS_DE_SEGURANCA` e `REGRAS_DE_SEGURANCA`. Um teste confere que todo literal usado no `src` está na lista.
   - `status` e `contagem`: números em faixa.
   - `origem`: HMAC.

   Valor fora do formato vira `[invalido]`, e campo desconhecido é descartado. Nome, CPF, telefone, e-mail, conteúdo clínico e mensagem de erro não têm campo onde entrar.
3. **Dado pseudonimizado, não anônimo (art. 13 §4):** `userId` e `origem` identificam uma pessoa para quem tem a tabela de usuários ou o segredo do HMAC. Por isso o log é dado pessoal e segue as regras dele: acesso restrito, retenção de 180 dias e registro no ROPA. As bases legais são o legítimo interesse e a segurança do titular (art. 7º IX, arts. 46 e 49) e o cumprimento de obrigação legal (art. 7º II) no que o Marco Civil exige.
4. **IP nunca em claro:** `origem` é um HMAC de 16 hex com o segredo do rate limit (`RATE_LIMIT_HASH_KEY`). Serve para correlacionar a mesma origem, não para identificar.
5. **Nenhum log da API carrega dado pessoal direto.** A trava de PR lê todo o `src` com o compilador do TypeScript e reprova:
   - `console.*`;
   - nomes sensíveis (`nome`, `cpf`, `telefone`, `email`, `conteudo`, `texto`, `corpo`, `message`, `stack`, `token`, `senha`…);
   - o erro inteiro, em qualquer forma: `err`, `${err}`, `String(err)` ou `'x' + err`. O certo é usar `err.name` ou `codigoDoErro(err)`;
   - spread, `JSON.stringify`, `util.inspect`, `Object.values/entries/keys`, `String(obj)`, `p['cpf']`, desestruturação renomeada ou cópia para variável local de campo sensível, nome composto (`cpfDoPaciente`), apelido do logger, chamada dinâmica `logger[metodo]` e `process.stdout/stderr.write`.

   Exceções só com motivo escrito, em `PERMITIDOS` ou `PERMITIDOS_POR_ARQUIVO`.

## 3. Catálogo de eventos

| Evento | Severidade | Alarme | Onde nasce |
|---|---|---|---|
| `SESSAO_INVALIDA` | aviso | volume | guard de sessão (401) |
| `ACESSO_NEGADO_PERFIL` | aviso | volume | guard de sessão (403 por perfil) |
| `MFA_RECUSADO` | aviso | volume | guard de sessão (sem MFA ou MFA antigo) |
| `MFA_LIMITE_DE_RECUSAS` | alto | imediato | guard de sessão (429, acima de 20 recusas em 60 s) |
| `RATE_LIMIT_EXCEDIDO` | aviso | volume | rate limit por IP (só no 1º estouro da janela) |
| `RATE_LIMIT_FAIL_OPEN` | alto | imediato | contador indisponível (IP, vigilância de leitura, portal) |
| `WEBHOOK_ASSINATURA_INVALIDA` | alto | volume | webhook do WhatsApp |
| `ALERTA_ANOMALIA` | alto | imediato | vigilância de leitura, portal, agenda, cadastro, vínculo cruzado no prontuário |
| `TRILHA_NAO_GRAVADA` | **crítico** | imediato | qualquer evento que devia ir para a trilha e não gravou |
| `EXPORTACAO_FALHOU` | alto | imediato | exportação total (G2) |
| `PERFIS_NAO_CONFERIDOS` | alto | imediato | guard de sessão (leitura de `clinic_members` falhou; requisição negada) |
| `CSRF_RECUSADO` | alto | volume | borda HTTP (escrita de origem fora da allowlist, 403) |
| `PORTAL_RESGATE_RECUSADO` | aviso | volume | resgate de convite do portal |

Severidade `aviso` sai como `warn`; `alto` e `crítico` saem como `error`. `RATE_LIMIT_FAIL_OPEN` e `MFA_RECUSADO` saem no máximo uma vez por minuto por chave (`registrarNoMaximoUmaVez`), para não inundar o log enquanto o Redis está fora ou um usuário insiste.

## 4. Alarmes no CloudWatch (para o devops-ci configurar no staging)

- **Filtro de métrica** por evento: `{ $.tipo = "seguranca" && $.evento = "<EVENTO>" }`.
- **Imediato:** um evento já alarma (`TRILHA_NAO_GRAVADA`, `MFA_LIMITE_DE_RECUSAS`, `RATE_LIMIT_FAIL_OPEN`, `ALERTA_ANOMALIA`, `EXPORTACAO_FALHOU`).
- **Volume:** alarma acima da linha de base. Sugestão inicial, a ajustar no piloto: mais de 50 `SESSAO_INVALIDA` por `origem` em 5 min, mais de 20 `ACESSO_NEGADO_PERFIL` por `userId` em 15 min, ou mais de 10 `WEBHOOK_ASSINATURA_INVALIDA` em 5 min.
- **Retenção do grupo de logs:** 180 dias, cifrado com KMS, com acesso restrito ao papel de operação. Depende da conta AWS.

## 5. Pendências (não cabem neste PR)

- **Marco Civil (art. 15):** o provedor de aplicação guarda os registros de acesso (IP, data e hora) por 6 meses, sob sigilo. O log de segurança guarda só o HMAC do IP. A guarda do IP em claro fica nos access logs do balanceador (ALB), cifrados e com acesso restrito. Confirmar com o advogado (pergunta para a D8) e configurar com a conta AWS.
- **Eventos do login e do MFA real** (login, falha, bloqueio, logout, troca de senha e de fator, reset): entram no PR da D4, com estes mesmos campos (R5 do parecer do #123; P4 e E11 das revisões internas de 04/11).
- **`origem` nos eventos do portal** (o do webhook já sai com `origem`) e testes de emissão nos módulos que ainda não têm (webhook, vigilâncias, exportação). O rate limit e o guard já têm teste.
- **Correlação por requisição:** um id de requisição em todas as linhas (E9 da revisão da equipe).
- **Front (site e app):** o `no-console` do web e o envio de erros do navegador sem dado pessoal ficam com a frente de front (L6 da triagem de 04/11).
