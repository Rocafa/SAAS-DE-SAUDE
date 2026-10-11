# Criptografia de campo por clínica (S5)

> Rodada 8, frente Engenharia. Código em `apps/api/src/modules/crypto/`, migração `0004_chaves_de_dados_por_clinica.sql`.
> Requisito: [requisitos-tecnicos-seguranca.md](../03-seguranca-lgpd/requisitos-tecnicos-seguranca.md) §2 (campos C4 cifrados na aplicação com DEK por tenant, KEK no KMS, crypto-shredding por tenant) e [retencao-e-descarte.md](../03-seguranca-lgpd/retencao-e-descarte.md) §4.1, opção C.

## 1. O que existe agora

| Peça | Arquivo | O que faz |
|---|---|---|
| `KeyProvider` | `key-provider.ts` | Fronteira com quem guarda a chave mestra (KEK): criar, gerar DEK, abrir, re-cifrar e destruir |
| `KmsKeyProvider` | `kms-key-provider.ts` | AWS KMS. Uma chave por clínica, `EncryptionContext = { tenant_id }`, rotação automática ligada, destruição com janela de 7 dias |
| `LocalKeyProvider` | `local-key-provider.ts` | Dev e teste. Imita o KMS com AES-256-GCM; **recusa `NODE_ENV=production`** |
| `FieldCipher` | `field-cipher.ts` | Cifra e decifra campos, provisiona, gira DEK e KEK, destrói as chaves da clínica |
| Formato | `field-format.ts` | `v1:<keyId>:<iv>:<tag>:<dado>` e AAD |
| Cache | `data-key-cache.ts` | DEK em claro na memória por 60 s (padrão), até 1.000 entradas |
| Persistência | `data-key-store.ts` + 0004 | `tenant_master_keys` e `tenant_data_keys`, com RLS FORCE |

O KMS entra por uma interface (`KmsApi`) com os nomes do SDK v3. **A dependência `@aws-sdk/client-kms` ainda não foi adicionada**: ela entra junto com a infraestrutura (Portão A do relatório da rodada 7), no `package.json` da API.

Ainda **não há coluna cifrada em uso**. As tabelas C4 (`record_entry`, anexos e outras) não existem. Este PR entrega o mecanismo, e cada tabela nova com campo 🔒 usa `FieldCipher` no repositório.

## 2. Como funciona

```
clínica ──1:1 ativa──► chave mestra (KEK)  ── KMS em sa-east-1, nunca sai de lá
                          │ cifra
                          ▼
                   DEK AES-256 (tenant_data_keys.wrapped_key, só cifrada)
                          │ cifra (AES-256-GCM, IV aleatório de 12 bytes)
                          ▼
  campo:  v1:<id da DEK>:<iv>:<tag>:<dado>     AAD = ["v1", clínica, tabela, coluna, id da linha]
```

- **AES-256-GCM só com `node:crypto`.** Cada valor tem IV aleatório de 96 bits e tag de 128 bits. FATO: o NIST SP 800-38D recomenda IV de 96 bits e limita o uso de IV aleatório a 2³² cifragens por chave ([NIST SP 800-38D §8.3](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf), consultado em 11/10/2026). ESTIMATIVA: nenhuma clínica chega perto disso por DEK, e a rotação de DEK zera a contagem.
- **AAD amarra o valor ao lugar.** Copiar a cifra para outra clínica, tabela, coluna ou linha faz a decifragem falhar.
- **A DEK fica amarrada à clínica duas vezes:** pelo RLS (a clínica B não enxerga as linhas de chave de A) e pelo `EncryptionContext` do KMS (ou AAD no provedor local). Por isso uma linha de chave copiada de A para B também não abre.
- **Falha fechada.** Sem DEK ativa, `encrypt` lança `TenantKeyMissingError`: o campo nunca é gravado em claro.
- **Formato versionado.** Uma v2 futura ganha prefixo próprio e convive com a v1 na leitura.

## 3. Rotação sem downtime

| Rotação | Como | Efeito nos dados |
|---|---|---|
| **DEK** (`rotateDataKey`) | A DEK ativa vira `retired` e uma nova passa a cifrar. Tudo numa transação, sob trava por clínica (`pg_advisory_xact_lock`) | Nenhum. Valores antigos abrem pela DEK aposentada; `reencrypt` atualiza aos poucos num job |
| **KEK de rotina** | Rotação automática anual do KMS (mesmo ARN) | Nenhum. O KMS guarda o material antigo |
| **KEK por suspeita** (`rotateMasterKey`) | Chave nova no KMS e `ReEncrypt` de cada DEK, sem a DEK passar pela aplicação | Nenhum. A KEK antiga fica `retired`, **não é destruída**, porque os backups anteriores dependem dela |

Não há janela de indisponibilidade: leitores que já têm a DEK antiga em cache continuam decifrando, e a única DEK ativa é garantida pelo índice único parcial e pela trava.

## 4. Destruição (crypto-shredding) — resposta à §4.1 de retenção

`destroyTenantKeys` faz, numa transação:
1. marca todas as DEKs da clínica como `destroyed` e apaga `wrapped_key`;
2. marca **todas** as chaves mestras da clínica (ativa e aposentadas) como `destroyed`;
3. zera o cache local;
4. chama `ScheduleKeyDeletion` no KMS para cada chave mestra, com 7 dias de espera. Se o KMS falhar, a transação desfaz.

FATO (AWS, [Delete an AWS KMS key](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html), consultado em 11/10/2026): a espera vai de 7 a 30 dias e pode durar até 24 h a mais. Durante a espera a chave não faz nenhuma operação criptográfica e a destruição pode ser cancelada. Depois de apagada, "you can no longer decrypt the data that was encrypted under that KMS key".

Consequência: o backup imutável (Object Lock) guarda as DEKs cifradas, mas sem a chave mestra elas não abrem. **Todas as cópias dos campos cifrados da clínica ficam ilegíveis em 7 a 8 dias**, contados do agendamento. O teste `test/crypto.rls.test.ts` prova isso com uma cópia das linhas de chave tirada antes da destruição.

Limites (honestos):
- só alcança o que estiver **cifrado com `FieldCipher`**. Campos C2/C3 em claro (nome de exibição, por exemplo) continuam nos backups até expirarem. A opção B da §4.1 (declarar o prazo) segue valendo para eles;
- em cada instância da API, a DEK já em cache vale até o TTL (60 s). A própria AWS avisa que agendar a exclusão "might not immediately affect data keys" já abertas;
- a destruição é por clínica, não por paciente. O descarte por paciente ou registro ([requisitos §82](../03-seguranca-lgpd/requisitos-tecnicos-seguranca.md)) pede DEK por paciente e fica para depois.

## 5. Nenhuma chave em log ou erro

- `DataKey` guarda os bytes num `WeakMap`, fora do objeto. `inspect`, `JSON.stringify` e `String` mostram só `[DataKey]`, e o teste confere.
- `destroy()` zera os bytes e qualquer uso depois disso lança erro: **nunca cifra com chave zerada**.
- Todos os erros têm mensagem fixa e não encadeiam `cause`. Erro do SDK do KMS (que traz ARN e id de requisição) vira `KeyUnavailableError`.
- O banco guarda só a DEK cifrada e a referência da chave mestra, que não é segredo.

## 6. Banco (0004)

- `tenant_master_keys(id = ARN, tenant_id, status, created_at, destroyed_at)`, com uma ativa por clínica.
- `tenant_data_keys(id, tenant_id, master_key_id → tenant_master_keys, wrapped_key, status, …)`, com uma ativa por clínica. `destroyed` exige `wrapped_key` nulo.
- RLS FORCE com `app_current_tenant()`. O runtime (`app_user`) não tem DELETE nem TRUNCATE, e UPDATE só nas colunas do ciclo de vida.
- Trigger `tenant_keys_guard`, que vale para qualquer papel: identidade imutável, `destroyed` terminal, nada volta a `active`, nenhuma linha é apagada.

## 7. Custo e limites no KMS

| Item | Valor | Tipo |
|---|---|---|
| Chave gerenciada pelo cliente | US$ 1/mês por chave, proporcional por hora | FATO ([AWS KMS pricing](https://aws.amazon.com/kms/pricing/), 11/10/2026) |
| Rotação automática | A 1ª e a 2ª rotação somam US$ 1/mês cada; as seguintes não são cobradas | FATO (mesma fonte) |
| Requisições | US$ 0,03 por 10.000; 20.000/mês grátis | FATO (mesma fonte) |
| Custo por clínica | ≈ US$ 1/mês no 1º ano, ≈ US$ 2 no 2º e ≈ US$ 3 do 3º em diante | ESTIMATIVA |
| Requisições por clínica | Baixas: o cache de 60 s faz ~1 `Decrypt` por DEK por minuto ativo por instância | ESTIMATIVA |

Pendente para o DevOps (Portão A): conferir a cota de chaves KMS por conta e região, e fazer a política IAM separar quem cria e destrói chave (job de onboarding e eliminação) de quem só gera e abre DEK (a API).

## 8. Testes

| Suíte | O que prova |
|---|---|
| `src/modules/crypto/field-cipher.test.ts` (25) | Ida e volta; formato; IV novo; outra clínica não decifra; adulteração de IV, tag, dado e keyId detectada; mover para outra tabela, coluna ou linha detectado; rotação de DEK e KEK; destruição deixa banco e backups ilegíveis; nada vaza em log ou erro; TTL do cache |
| `src/modules/crypto/key-providers.test.ts` | Provedor local (recusa produção, DEK de A não abre como B, destruição) e KMS contra um KMS falso (contexto, janela de 7 dias, erro sem ARN) |
| `test/crypto.rls.test.ts` (Postgres real, 7) | RLS FORCE nas tabelas de chave; B não vê nem grava chave de A; o runtime não apaga nem reativa chave; provisionamento concorrente gera uma só chave; crypto-shredding com cópia de backup |
