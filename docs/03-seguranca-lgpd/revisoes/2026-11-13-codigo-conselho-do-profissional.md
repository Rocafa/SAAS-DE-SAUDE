# Revisão de código: conselho e número de registro do profissional (PR #194)

**Veredito: VETADO** (1 bloqueante, B1). Corrigido o B1, aprovo com as ressalvas R1 a R6 registradas como pendência.

- Branch: `eng/registro-no-conselho` (commit 584d73c), diff `origin/main...HEAD`, 10 arquivos.
- Revisor: guardião LGPD & segurança, 13/11/2026.
- Base normativa: Res. COFFITO 414/2012 e 415/2012, art. 1º §1º VIII (identificação de quem registra: nome completo e número no CREFITO), conferidas pelo autor do PR e por este revisor; LGPD art. 6º III (necessidade) e V (qualidade dos dados), art. 7º II (obrigação regulatória) e art. 18 III (correção).
- Verificação local: `registro-no-conselho.test.ts` 2/2 verde. No CI, no momento da revisão, "Isolamento entre tenants (RLS)" e "Lint, typecheck e testes" ainda estavam pendentes: o aceite depende deles verdes.

## O que está certo

- **Base legal:** art. 7º II (obrigação regulatória do conselho). O número no conselho é dado pessoal do profissional (identifica pessoa natural), mas não é sensível (art. 5º II) e é público na consulta do próprio conselho. Não precisa de consentimento.
- **Minimização:** só conselho (lista fechada) e número. `exigirObjeto` recusa campo a mais; CHECK no banco espelha a regex; par "os dois ou nenhum" (`0074_registro_no_conselho.sql:15`).
- **Controle de acesso:** `cadastros:gerir` + `@ExigeMfaRecente` (`scheduling.controller.ts:101-103`), na lista de cobertura de auditoria e de MFA (`test/cobertura-auditoria/lista.ts`).
- **Isolamento:** filtro por `tenantId` no SELECT FOR UPDATE e no UPDATE, sobre a policy `tenant_isolation` já existente em `professionals` (0007). Teste de outra clínica devolve 404.
- **Trilha sem o número:** aceitável e coerente com a política de trilha mínima. O dado é público, então guardar o número na trilha não seria grave, mas a trilha é longa e replicada; a alternativa certa é o histórico do B1, não a trilha.
- **Exportação G2:** `tenant-export.ts` 1.25.0 inclui `council` e `councilRegistration` em `professionals[]`; testes de exportação usam `EXPORT_SCHEMA_VERSION`, sem número fixo a quebrar.
- **Retenção:** a linha de `professionals` não é apagada (`REVOKE DELETE` na 0007), então acompanha os 20 anos do prontuário.
- **Numeração 0074:** o runner (`scripts/migrate.mjs:29-32`) aplica o que não está em `schema_migrations` em ordem de nome, com lacuna. Conferi 0065–0073 da pilha do login (`origin/eng/anonimizacao-suporte`): nenhuma altera `professionals` (a 0072 só cita em comentário). Ordem de aplicação indiferente.
- **Testes sem verde falso:** o teste RLS por SQL direto usa o papel da aplicação via `withTenant` e confere o código 23514; o 404 entre clínicas não pode passar por 403 de MFA; a trilha é comparada por igualdade exata e sem "123456". Dados fictícios.

## Bloqueante

**B1. A troca do número apaga o número que valia quando o registro clínico foi feito.** `scheduling.service.ts:401` sobrescreve `council`/`council_registration`, e a trilha (`:408`) não guarda o valor anterior. Quando o profissional muda de região (ex.: CREFITO-3 para CREFITO-2) ou o admin corrige um erro, toda evolução antiga passa a sair, na tela e na exportação (`tenant-export.ts:360-361`, um valor só por profissional), com o número novo. Isso contraria o próprio fim declarado no PR (identificar quem registrou, COFFITO 414/415 art. 1º §1º VIII) e o art. 6º V (qualidade), e não tem volta depois de usado em produção.
**Correção (uma das duas):**
- (a) tabela `professional_council_history (tenant_id, professional_id, council, council_registration, valid_from, set_by)` só de INSERT (sem UPDATE/DELETE para `app_user`), com RLS por tenant, preenchida na mesma transação de `definirRegistroNoConselho`, e exportada no G2; ou
- (b) gravar conselho e número no registro clínico no momento da assinatura (retrato imutável).
Um teste deve provar que, depois de uma troca, o valor anterior continua recuperável e exportado.

## Ressalvas (não bloqueiam após o B1; registrar pendência)

**R1. Duas fontes para o mesmo dado.** `professional_fiscal_profiles.council_registration` (0018:51-52; `financeiro.service.ts:230`; recibo em `recibos.service.ts:485`) já guarda o número em texto livre (com espaço e com a sigla, ex.: "CREFITO-0 00000-TO"), gerido por outra permissão. O recibo e o prontuário podem mostrar números diferentes do mesmo profissional (art. 6º V). Definir `professionals` como fonte única e o recibo lê dali (ou migrar e descontinuar o campo fiscal) em microparte própria.

**R2. O formato não impede nome, só espaço.** `scheduling.validation.ts:123` e o CHECK da 0074:12 aceitam "FulanoDeTal" ou "fulano.tal". Exigir ao menos um dígito (`(?=.*[0-9])` na regex e `council_registration ~ '[0-9]'` no CHECK) e acrescentar o caso ao teste (`registro-no-conselho.test.ts:24`). O título do teste (`:22`) promete "sem ecoar o valor", mas nada confere isso: verificar que a mensagem/campos do erro não contêm o valor enviado.

**R3. Quem altera.** Admin com MFA está correto: a clínica (controladora) responde pela identificação do autor e deve conferir o número na consulta pública do conselho antes de gravar. Não recomendo o próprio profissional editar sem conferência (autodeclaração vira assinatura no prontuário). Recomendo: (i) o profissional VER o próprio registro (art. 18 I/II) e pedir correção ao admin (art. 18 III); (ii) avisar o profissional quando o admin trocar o número dele (mesmo canal de `avisos.ts`).

**R4. Lista de conselhos.** Para o nicho de entrada (fisio/TO, psicologia, fono/TEA, nutrição, odonto, medicina) a lista cobre: CREFITO (fisio e TO), CRP, CRFa, CRN, CRO, CRM. Faltam para os nichos já pesquisados: **COREN** (enfermagem, clínicas multiprofissionais e estética), **CRBM** (biomedicina, estética: `docs/01-mercado/nichos/estetica.md:51`), **CRF** (farmácia, estética) e **CREF** (educação física: pilates e reabilitação em clínica de fisio). Acrescentar ao menos COREN agora (é só o CHECK e `CONSELHOS`); os demais podem esperar a onda do nicho. Profissionais sem conselho (AT, psicopedagogo, esteticista) ficam com o par nulo, o que o desenho já permite.

**R5. Não há como limpar o registro.** A rota só define; não aceita nulo. Se o número foi lançado no profissional errado, o admin não consegue removê-lo (art. 18 III/VI). Aceitar `{conselho: null, registro: null}` com a mesma trilha, depois do histórico do B1.

**R6. Documentação e cobertura de teste.**
- `docs/04-arquitetura/api-dominio.md:508`: a linha entrou no meio da tabela R1–R4 do portal (colunas "Item / O que mudou / Prova"); mover para a tabela de rotas de cadastro.
- Falta caso de segunda definição (`had_registration: true`) no teste RLS.
- A sessão do portal lê `professionals` sem restrição de coluna (0027:270-272), então passa a enxergar `council_registration` por SQL. O dado é público e já sai no recibo; aceito, mas registrar na nota da 0027 que a coluna é deliberadamente visível.

## Checklist

| Item | Situação |
|---|---|
| Base legal (art. 7º/11) | OK (art. 7º II; não sensível) |
| Minimização | OK, com R2 |
| Consentimento | Não se aplica |
| Criptografia em trânsito/repouso | Sem mudança (texto em claro aceitável: dado público, não sensível) |
| Isolamento por tenant | OK |
| Controle de acesso | OK (admin + MFA), R3 |
| Trilha de auditoria | OK, sem o número; histórico via B1 |
| Retenção (20 anos) | Falha parcial: B1 (valor histórico se perde) |
| Segredos / dados reais | Nenhum; dados fictícios |
| COFFITO 414/415 | Atende no valor atual; B1 para o histórico |
