# Backlog do MVP — Épicos e histórias de usuário

> Frente: 🧩 Produto (N2) · Versão 0.1 · Data: 2026-10-08
> Base: [PRD.md](./PRD.md) · [WBS-micropartes.md](./WBS-micropartes.md) (IDs e critérios de pronto por microparte) · [roadmap.md](./roadmap.md) (marcos M0–M4) · [jornadas.md](./jornadas.md) · [definicao-de-pronto.md](./definicao-de-pronto.md) · [metricas-produto.md](./metricas-produto.md)
> Estimativas em story points são **ESTIMATIVAS** de Produto, a recalibrar pela Engenharia no planejamento técnico.

## Convenções

- **ID:** `HU-<MOD>-NNN`, onde `MOD` é o módulo da microparte principal da WBS.
- **Formato:** "Como <persona>, quero <ação>, para <benefício>". Personas do [PRD](./PRD.md) §3: Carla (dona/admin), Dr. Rafael (médico), Juliana (recepção), Marcos (psico), Lívia (nutri), Diego (fisio/TO), Renata (fono/TEA), Dra. Bianca (odonto), Dra. Paula (estética), paciente (Antônio/Ana). Personas internas: encarregado (DPO) da clínica, Guardião LGPD, analista de suporte, engenheira da plataforma.
- **Pontos:** Fibonacci (1, 2, 3, 5, 8, 13). 13 é o teto (ver DoR).
- **MoSCoW:** Must / Should / Could / Won't (nesta fase). Os itens *Should/Could* coincidem com o corte pré-acordado do [roadmap](./roadmap.md) §8.
- **LGPD:** `S` se qualquer microparte coberta tem "Dado sensível = S" na WBS → exige cenário de erro/segurança e aprovação do Guardião LGPD.
- **Tags de nicho:** o nicho de entrada ainda não foi decidido (**D1** em [decisoes.md](../00-governanca/decisoes.md)). Histórias sem tag são do **núcleo comum**. Histórias específicas têm `[nicho:X]` com X ∈ `medicina`, `psico`, `nutri`, `fisio-to`, `fono-tea`, `odonto`, `estetica`. Para reordenar após D1: filtrar por tag e mover para trás as tags fora do nicho escolhido.
  - D1 opção (a) → priorizar `psico`, `nutri`, `fisio-to`;
  - D1 opção (b) → priorizar `fono-tea`, `fisio-to`.
- **Nível de detalhe:** histórias dos marcos **M0 e M1** estão completas (Gherkin). M2–M4 listadas com título, IDs WBS, pontos, MoSCoW e flag LGPD; o Gherkin delas é escrito no refinamento (DoR) antes de cada marco.

## Sumário

| Épico | Nome | Marco | Histórias | Pontos |
|---|---|---|---|---|
| EP-01 | Fundação multi-tenant e plataforma técnica | M0 | 11 | 60 |
| EP-02 | Identidade, acesso e sigilo | M0 | 7 | 35 |
| EP-03 | Auditoria | M0 | 2 | 13 |
| EP-04 | Governança LGPD base | M0 | 4 | 14 |
| EP-05 | Backoffice interno seguro | M0 | 2 | 8 |
| EP-06 | Onboarding e cadastro de pacientes | M1 | 9 | 39 |
| EP-07 | Agenda | M1 | 10 | 45 |
| EP-08 | Prontuário — núcleo | M1 | 10 | 62 |
| EP-09 | Prontuário por nicho | M1 | 13 | 47 |
| EP-10 | Gate LGPD (consentimento, retenção, RIPD) | M1 | 3 | 18 |
| EP-11 | WhatsApp e comunicação | M2 | 15 | 79 |
| EP-12 | Agendamento online e bot | M2 | 9 | 44 |
| EP-13 | Documentos clínicos e assinatura | M3 | 11 | 64 |
| EP-14 | Escriba e IA clínica | M3 | 12 | 74 |
| EP-15 | Financeiro e repasse | M4 | 5 | 26 |
| EP-16 | Pagamentos (Pix e cartão) | M4 | 5 | 32 |
| EP-17 | Fiscal (NFS-e) | M4 | 3 | 16 |
| EP-18 | Portal do paciente | M4 | 5 | 24 |
| EP-19 | Direitos do titular e prontidão LGPD para GA | M4 | 5 | 26 |
| EP-20 | Migração e exportação | M4 | 10 | 56 |
| EP-21 | Billing da plataforma | M4 | 6 | 27 |
| EP-22 | Relatórios, NPS e métricas | M4 | 6 | 31 |
| EP-23 | Suporte e backoffice | M4 | 5 | 24 |
| **Total** | **23 épicos** | | **168** | **864** |

| Recorte | Histórias | Pontos |
|---|---|---|
| M0 | 26 | 130 |
| M1 | 45 | 211 |
| **M0 + M1** | **71** | **341** |
| M2 | 24 | 123 |
| M3 | 23 | 138 |
| M4 | 50 | 262 |
| **MVP total** | **168** | **864** |

- **MoSCoW:** 139 Must · 21 Should · 8 Could. **Flag LGPD = S:** 83 histórias.
- **Histórias com tag de nicho:** HU-PRO-009, HU-PRO-012 a HU-PRO-023, HU-DOC-001, HU-DOC-002, HU-DOC-004, HU-PRO-024, HU-PRO-025 (as demais são núcleo comum).
- **Velocidade de referência (ESTIMATIVA):** 2 squads de engenharia a ~30 pts/semana somados → M0+M1 em ~11–12 semanas (o roadmap prevê 14). Recalibrar após 2 iterações.
- A seção [Rastreabilidade](#rastreabilidade-wbs--histórias) ao final confirma que as 186 micropartes MVP da WBS estão cobertas.

---

# Marco M0 — Fundação

## EP-01 — Fundação multi-tenant e plataforma técnica

### HU-NUC-001 — Isolamento de dados por clínica
**WBS:** NUC-01.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** — · **Pontos:** 13 · **MoSCoW:** Must · **LGPD:** S

Como **Carla (dona da clínica)**, quero que os dados da minha clínica fiquem isolados dos de qualquer outra clínica, para garantir o sigilo dos meus pacientes e cumprir a LGPD.

```gherkin
Funcionalidade: Isolamento por tenant
  Cenário: Leitura cruzada bloqueada
    Dado um usuário autenticado na clínica A
    Quando ele requisita um paciente que pertence à clínica B pelo ID
    Então a API responde 404 sem revelar a existência do registro
    E um evento de segurança "acesso_cruzado_negado" é registrado na auditoria

  Cenário: Requisição sem contexto de tenant
    Dado uma requisição autenticada sem tenant resolvido
    Quando ela chega a qualquer endpoint de dados
    Então a requisição é rejeitada com 401 antes de tocar o banco

  Cenário: Escrita com tenant forjado
    Dado um usuário da clínica A
    Quando ele envia um payload com "tenant_id" da clínica B
    Então o banco recusa a escrita pela política RLS com FORCE
    E nenhum dado da clínica B é alterado

  Cenário: Cobertura no CI
    Dado a suíte de isolamento de tenant
    Quando o CI roda em qualquer PR
    Então 100% dos endpoints com dado de tenant são testados e o PR é bloqueado se algum falhar
```

### HU-NUC-002 — Unidades, salas e recursos
**WBS:** NUC-01.3 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero cadastrar unidades, salas e equipamentos agendáveis, para organizar onde cada atendimento acontece.

```gherkin
  Cenário: Cadastro de sala vinculável
    Dado que Carla cadastrou a unidade "Centro" com a sala "Sala 2"
    Quando Juliana cria um agendamento
    Então "Sala 2" aparece como opção de recurso

  Cenário: Unidade na página pública
    Dado uma unidade ativa com endereço preenchido
    Quando a página pública da clínica é aberta
    Então a unidade aparece com o endereço, sem CNES se ele não foi informado
```

### HU-NUC-003 — Configurações da clínica
**WBS:** NUC-01.4 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero definir fuso, horário de funcionamento, logo e papel timbrado, para que documentos, lembretes e página pública reflitam a identidade da clínica.

```gherkin
  Cenário: Logo refletido nos documentos
    Dado que Carla enviou um logo e o papel timbrado
    Quando um documento é gerado
    Então o PDF usa o logo e o timbre configurados

  Cenário: Fuso aplicado
    Dado uma clínica configurada no fuso "America/Manaus"
    Quando um horário é exibido na agenda e no lembrete
    Então ambos mostram o horário local da clínica
```

### HU-NUC-004 — Criptografia em repouso, em trânsito e por campo
**WBS:** NUC-05.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** — · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **encarregado (DPO) da clínica**, quero que os dados clínicos fiquem criptografados no banco e na rede, para que um vazamento de infraestrutura não exponha prontuários.

```gherkin
  Cenário: Conexão insegura recusada
    Dado um cliente tentando conectar por HTTP ou TLS 1.0
    Quando ele chama qualquer endpoint
    Então a conexão é recusada ou redirecionada para TLS 1.2+

  Cenário: Campo clínico ilegível no banco
    Dado um registro clínico salvo
    Quando um operador consulta a tabela diretamente no banco
    Então o conteúdo clínico aparece cifrado

  Cenário: Rotação de chave sem perda
    Dado uma chave de tenant em uso
    Quando a chave é rotacionada no KMS
    Então os registros antigos continuam legíveis pela aplicação e os novos usam a nova chave
```

### HU-NUC-005 — Armazenamento seguro de arquivos
**WBS:** NUC-05.2 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-004 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero anexar arquivos com segurança, para que exames e documentos só sejam vistos por quem tem permissão.

```gherkin
  Cenário: URL assinada expira
    Dado um anexo acessado por URL assinada
    Quando a URL é usada após o tempo de expiração
    Então o acesso é negado

  Cenário: Upload infectado bloqueado
    Dado um arquivo com assinatura de malware
    Quando ele é enviado
    Então o upload é bloqueado e o usuário recebe mensagem clara

  Cenário: Acesso sem permissão
    Dado um usuário de outra clínica com uma URL de arquivo copiada
    Quando ele tenta abrir o arquivo
    Então o acesso é negado e registrado na auditoria
```

### HU-NUC-006 — Notificações internas sem conteúdo clínico
**WBS:** NUC-05.3 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-011 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Juliana (recepção)**, quero receber notificações em tempo real dentro do sistema, para reagir rápido a mudanças na agenda.

```gherkin
  Cenário: Notificação em tempo real
    Dado que um paciente cancelou um horário
    Quando o cancelamento é registrado
    Então Juliana recebe a notificação em até 5 segundos e pode marcá-la como lida

  Cenário: Preview sem dado clínico
    Dado uma notificação ligada a um atendimento
    Quando ela aparece no preview
    Então não exibe diagnóstico, queixa ou conteúdo de prontuário
```

### HU-NUC-007 — Eventos de domínio e jobs confiáveis
**WBS:** NUC-05.4 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** — · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **engenheira da plataforma**, quero um barramento de eventos e jobs com retentativa e idempotência, para que lembretes, cobranças e descartes não se percam nem dupliquem.

```gherkin
  Cenário: Retentativa sem duplicar
    Dado um job que falha na primeira execução
    Quando ele é reprocessado
    Então o efeito acontece uma única vez (consumidor idempotente)

  Cenário: Painel de filas
    Dado jobs pendentes e com erro
    Quando a engenheira abre o painel de filas
    Então vê contagens por fila e pode reprocessar os com erro
```

### HU-NUC-008 — Observabilidade sem PII
**WBS:** NUC-05.5 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** — · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **engenheira da plataforma**, quero logs estruturados, métricas, tracing e SLOs sem dado pessoal, para operar o sistema sem expor pacientes.

```gherkin
  Cenário: Varredura de PII nos logs
    Dado um log contendo um padrão de CPF ou telefone
    Quando a varredura automática roda
    Então um alerta é aberto e o build/deploy correspondente é bloqueado

  Cenário: Dashboard de SLO
    Dado o serviço em produção
    Quando a disponibilidade cai abaixo de 99,9% na janela
    Então o alerta de SLO dispara para o plantão
```

### HU-NUC-009 — Backup e recuperação testados
**WBS:** NUC-05.6 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-004 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Carla**, quero backups criptografados e restauração testada, para nunca perder prontuários.

```gherkin
  Cenário: Restauração ponto-no-tempo
    Dado uma simulação de perda do banco principal
    Quando a restauração é executada
    Então o RPO é ≤ 15 min e o RTO ≤ 4 h, com relatório arquivado

  Cenário: Backup inacessível sem chave
    Dado um arquivo de backup copiado para fora do ambiente
    Quando alguém tenta lê-lo sem acesso ao KMS
    Então o conteúdo é ilegível
```

### HU-NUC-010 — Feature flags e rollout
**WBS:** NUC-05.7, ADM-01.3 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **analista de produto interno**, quero ligar recursos por clínica, plano ou percentual sem deploy, para liberar o piloto aos poucos e reverter rápido.

```gherkin
  Cenário: Liberação por tenant
    Dado a flag "escriba" desligada
    Quando ela é ligada para a clínica piloto X
    Então apenas usuários da clínica X veem o recurso, sem deploy

  Cenário: Rollback rápido e auditado
    Dado uma flag ligada causando erro
    Quando o analista a desliga no console
    Então o recurso some em menos de 1 minuto e a ação fica registrada com autor
```

### HU-INT-001 — Bases de referência versionadas
**WBS:** INT-01.4 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** — · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **Dr. Rafael**, quero que CID, medicamentos, TUSS, TACO e feriados estejam atualizados e versionados, para registrar e prescrever com informação correta.

```gherkin
  Cenário: Atualização sem downtime
    Dado uma nova versão da base CMED
    Quando ela é publicada
    Então a busca de medicamentos continua disponível durante a troca

  Cenário: Versão registrada no uso
    Dado um registro que usou um código CID
    Quando o registro é salvo
    Então a versão da base CID usada fica gravada junto
```

## EP-02 — Identidade, acesso e sigilo

### HU-NUC-011 — Convite e gestão de usuários
**WBS:** NUC-02.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero convidar, desativar e transferir responsabilidades de usuários, para controlar quem trabalha na clínica.

```gherkin
  Cenário: Convite aceito
    Dado que Carla convidou Juliana com o papel "recepção"
    Quando Juliana aceita o convite e define a senha
    Então ela acessa apenas os recursos do papel recepção

  Cenário: Desativação imediata
    Dado um usuário com sessão aberta
    Quando Carla o desativa
    Então a próxima requisição dele é negada e a autoria dos registros antigos é preservada
```

### HU-NUC-012 — Login seguro
**WBS:** NUC-02.2 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-011 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero entrar com e-mail e senha protegidos contra ataques, para que ninguém acesse meus pacientes com minha conta.

```gherkin
  Cenário: Bloqueio por tentativas
    Dado 5 tentativas de senha errada em 15 minutos
    Quando ocorre a 6ª tentativa
    Então a conta é temporariamente bloqueada e o titular é avisado por e-mail

  Cenário: Recuperação sem enumeração
    Dado um e-mail não cadastrado
    Quando alguém pede recuperação de senha
    Então a resposta é idêntica à de um e-mail cadastrado

  Cenário: Senha armazenada com hash forte
    Dado um usuário recém-criado
    Quando a senha é persistida
    Então ela é guardada com Argon2id (ou bcrypt) e nunca aparece em logs
```

### HU-NUC-013 — MFA obrigatório para acesso clínico e financeiro
**WBS:** NUC-02.3 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-012 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **encarregado (DPO) da clínica**, quero que papéis com acesso clínico ou financeiro usem segundo fator, para reduzir o risco de conta invadida.

```gherkin
  Cenário: Prontuário exige MFA
    Dado um profissional sem MFA configurado
    Quando ele tenta abrir um prontuário
    Então é redirecionado para configurar o TOTP e o prontuário não é exibido

  Cenário: Recuperação de MFA auditada
    Dado um profissional que perdeu o celular
    Quando o admin reseta o MFA dele
    Então a ação exige justificativa e gera evento de auditoria
```

### HU-NUC-014 — Sessões e logout remoto
**WBS:** NUC-02.4 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-012 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Dr. Rafael**, quero ver minhas sessões ativas e encerrá-las remotamente, para me proteger se esquecer o computador da clínica logado.

```gherkin
  Cenário: Expiração por inatividade
    Dado a clínica configurada para expirar sessões em 30 minutos
    Quando o usuário fica 30 minutos inativo
    Então a sessão expira e ele precisa autenticar de novo

  Cenário: Logout remoto
    Dado duas sessões ativas
    Quando o usuário encerra a sessão do outro dispositivo
    Então aquele dispositivo perde acesso em menos de 1 minuto
```

### HU-NUC-015 — Perfil profissional com conselho de classe
**WBS:** NUC-02.6 · **Marco:** M0 · **Frente:** Produto · **Depende de:** HU-NUC-011 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Marcos (psicólogo)**, quero cadastrar conselho, número, UF, especialidades e assinatura visual, para que meus documentos saiam com a identificação correta.

```gherkin
  Esquema do Cenário: Conselhos de todos os nichos
    Dado um profissional do nicho "<nicho>"
    Quando ele preenche o perfil
    Então o conselho "<conselho>" está disponível com validação de UF e número
    Exemplos:
      | nicho    | conselho |
      | medicina | CRM      |
      | odonto   | CRO      |
      | psico    | CRP      |
      | nutri    | CRN      |
      | fisio-to | CREFITO  |
      | fono-tea | CRFa     |

  Cenário: Dados usados em documentos
    Dado um perfil completo
    Quando um documento é gerado
    Então nome, conselho, número e UF aparecem no rodapé
```

### HU-NUC-016 — Papéis padrão (RBAC)
**WBS:** NUC-03.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-011 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **Carla**, quero papéis prontos (administrador, profissional, recepção, financeiro, faturista, gestor), para dar a cada pessoa só o acesso que ela precisa.

```gherkin
  Cenário: Recepção sem conteúdo clínico
    Dado Juliana com papel recepção
    Quando ela tenta abrir a evolução de um paciente pela API
    Então recebe 403 e a tentativa é registrada na auditoria

  Cenário: Financeiro vê cobrança, não prontuário
    Dado um usuário com papel financeiro
    Quando ele abre a linha do tempo do paciente
    Então vê pagamentos e recibos, mas nenhum evento clínico

  Cenário: Matriz testada
    Dado a matriz papel × recurso documentada
    Quando a suíte de autorização roda no CI
    Então cada célula da matriz tem teste correspondente verde
```

### HU-NUC-017 — Sigilo do prontuário por vínculo de cuidado
**WBS:** NUC-03.3 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** HU-NUC-016 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **Marcos (psicólogo)**, quero que apenas eu e quem eu autorizar leiam os registros dos meus pacientes, para preservar o sigilo profissional.

```gherkin
  Cenário: Outro profissional sem compartilhamento
    Dado um registro de Marcos sem compartilhamento
    Quando a nutricionista da mesma clínica tenta abri-lo
    Então o acesso é negado e auditado

  Cenário: Gestor não lê conteúdo clínico
    Dado Carla com papel gestor sem vínculo de cuidado
    Quando ela tenta abrir a evolução
    Então vê apenas metadados administrativos (data, profissional, status)

  Cenário: Compartilhamento explícito
    Dado que Marcos compartilhou o registro com Renata
    Quando Renata abre o registro
    Então o acesso é permitido e auditado com a origem do compartilhamento
```

## EP-03 — Auditoria

### HU-NUC-018 — Trilha de auditoria imutável
**WBS:** NUC-04.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **encarregado (DPO) da clínica**, quero que toda leitura e escrita de dado sensível fique registrada de forma imutável, para responder a titulares e à ANPD com evidência.

```gherkin
  Cenário: Leitura de prontuário auditada
    Dado um profissional que abre um prontuário
    Quando a tela carrega
    Então um evento com usuário, paciente, ação, data/hora, IP e dispositivo é gravado

  Cenário: Adulteração detectável
    Dado a cadeia de hashes da trilha
    Quando um registro antigo é alterado diretamente no banco
    Então a verificação de integridade aponta a quebra da cadeia

  Cenário: Trilha sem conteúdo clínico
    Dado um evento de auditoria
    Quando ele é gravado
    Então contém referências (IDs) e nunca o texto do prontuário
```
> Retenção dos eventos: ≥ 20 anos para eventos clínicos (WBS); retenção geral depende da decisão **D7**.

### HU-NUC-019 — Consulta de auditoria
**WBS:** NUC-04.2 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-018 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **encarregado (DPO) da clínica**, quero filtrar a auditoria por paciente, usuário, período e ação, para saber quem acessou os dados de um paciente.

```gherkin
  Cenário: Consulta rápida
    Dado 1 ano de eventos de um paciente
    Quando o encarregado filtra por esse paciente
    Então o resultado aparece em menos de 3 segundos e pode ser exportado

  Cenário: Acesso restrito à consulta
    Dado Juliana com papel recepção
    Quando ela tenta abrir a tela de auditoria
    Então o acesso é negado
```

## EP-04 — Governança LGPD base

### HU-LGP-001 — Matriz de finalidades e bases legais no código
**WBS:** LGP-01.1 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** — · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Guardião LGPD**, quero que cada tratamento de dado declare finalidade e base legal num enum do código, para que nenhum dado seja usado fora da finalidade.

```gherkin
  Cenário: Finalidade obrigatória
    Dado um novo endpoint que grava dado pessoal
    Quando ele não declara uma finalidade do enum
    Então o teste de arquitetura falha no CI

  Cenário: Uso fora da finalidade
    Dado um dado coletado com finalidade "tutela da saúde"
    Quando um job de marketing tenta lê-lo sem consentimento de marketing
    Então a leitura é negada
```

### HU-LGP-002 — Termos e política versionados com reaceite
**WBS:** LGP-01.3 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** HU-LGP-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero aceitar termos e política com versão registrada e modelos para usar com meus pacientes, para ter evidência de conformidade.

```gherkin
  Cenário: Aceite registrado por versão
    Dado a versão 1.0 dos termos
    Quando Carla aceita
    Então o aceite fica gravado com versão, data e usuário

  Cenário: Reaceite em mudança material
    Dado a publicação da versão 2.0 marcada como mudança material
    Quando um admin entra no sistema
    Então precisa reaceitar antes de continuar
```

### HU-LGP-003 — Contrato de operador (DPA) e suboperadores
**WBS:** LGP-01.4 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** HU-LGP-002 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla (controladora)**, quero aceitar o contrato de operador e ver a lista de suboperadores, para saber quem trata os dados dos meus pacientes.

```gherkin
  Cenário: DPA antes de dado de paciente
    Dado uma clínica sem DPA aceito
    Quando alguém tenta cadastrar o primeiro paciente
    Então o sistema bloqueia e pede o aceite do DPA

  Cenário: Mudança de suboperador notificada
    Dado a inclusão de um novo suboperador
    Quando a lista pública é atualizada
    Então todas as clínicas recebem notificação com antecedência definida no DPA
```

### HU-LGP-004 — ROPA e privacy review no ciclo de desenvolvimento
**WBS:** LGP-03.1, LGP-03.5 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** HU-LGP-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Guardião LGPD**, quero que PRs com dado sensível passem pelo checklist e que o ROPA seja atualizado a cada feature, para manter a conformidade contínua.

```gherkin
  Cenário: PR com flag S sem aprovação
    Dado um PR que toca microparte com flag S
    Quando não há aprovação do Guardião
    Então o merge é bloqueado pela proteção de branch

  Cenário: ROPA cobre o módulo
    Dado um módulo MVP entregue
    Quando o marco é revisado
    Então o ROPA contém as operações de tratamento desse módulo
```

## EP-05 — Backoffice interno seguro

### HU-ADM-001 — Console de tenants sem dado clínico
**WBS:** ADM-01.1 · **Marco:** M0 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **analista de suporte**, quero buscar clínicas e ver status, plano e uso, para atender clientes sem acessar dados de pacientes.

```gherkin
  Cenário: Visão da conta
    Dado uma clínica cliente
    Quando o analista a busca no console
    Então vê plano, status, uso e saúde da conta

  Cenário: Nenhum dado clínico
    Dado qualquer tela do console
    Quando ela é renderizada
    Então não exibe nome de paciente nem conteúdo clínico
```

### HU-ADM-002 — Acesso privilegiado interno sob aprovação
**WBS:** ADM-01.7 · **Marco:** M0 · **Frente:** LGPD · **Depende de:** HU-ADM-001 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Guardião LGPD**, quero que ninguém do time tenha acesso permanente a produção, para reduzir risco de vazamento interno.

```gherkin
  Cenário: Acesso temporário aprovado
    Dado uma engenheira que precisa investigar produção
    Quando ela pede acesso com justificativa e um aprovador aceita
    Então recebe acesso por tempo limitado com a sessão gravada

  Cenário: Acesso sem aprovação negado
    Dado um colaborador sem aprovação vigente
    Quando ele tenta conectar ao banco de produção
    Então a conexão é negada e um alerta é gerado
```

---

# Marco M1 — Núcleo clínico

## EP-06 — Onboarding e cadastro de pacientes

### HU-NUC-020 — Onboarding da clínica em menos de 5 minutos
**WBS:** NUC-01.2 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-NUC-001, HU-BIL-001 (trial — usar stub de plano até o M4) · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero um assistente que crie a conta com dados da clínica, nicho(s), profissionais e horários, para começar a usar no mesmo dia.

```gherkin
  Cenário: Primeira agenda configurada
    Dado uma nova conta
    Quando Carla conclui o wizard (dados, nicho, profissionais, horários)
    Então a primeira agenda fica disponível e o tempo total é < 5 min no teste com 5 usuários

  Cenário: Nicho define modelos sugeridos
    Dado que Carla escolheu os nichos "psico" e "nutri"
    Quando o wizard termina
    Então os modelos de prontuário desses nichos aparecem pré-selecionados

  Cenário: Retomar de onde parou
    Dado que Carla fechou o navegador no passo 3
    Quando ela volta
    Então o wizard retoma no passo 3 com os dados salvos
```

### HU-PAC-001 — Ficha do paciente com minimização e nome social
**WBS:** PAC-01.1 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-NUC-001, HU-LGP-003 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Juliana**, quero cadastrar um paciente só com nome e telefone e completar o resto depois, para não travar o agendamento.

```gherkin
  Cenário: Cadastro mínimo
    Dado a tela de novo paciente
    Quando Juliana informa apenas nome e telefone
    Então o paciente é criado (CPF e demais campos opcionais)

  Cenário: Nome social em toda a interface
    Dado um paciente com nome social "Ana"
    Quando ele aparece na agenda, na inbox e no prontuário
    Então o nome social é exibido no lugar do nome civil

  Cenário: Cadastro auditado e isolado
    Dado um paciente criado na clínica A
    Quando um usuário da clínica B busca pelo mesmo CPF
    Então nenhum resultado é retornado
    E a criação na clínica A gerou evento de auditoria
```

### HU-PAC-002 — Responsáveis legais e acompanhantes
**WBS:** PAC-01.2 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PAC-001 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Renata (fono/TEA)**, quero vincular responsáveis legais e contatos de emergência ao paciente, para falar com a família certa sobre crianças e pessoas sob curatela.

```gherkin
  Cenário: Menor exige responsável
    Dado um paciente com data de nascimento de 8 anos
    Quando Juliana tenta salvar sem responsável
    Então o sistema exige ao menos um responsável legal

  Cenário: Comunicação ao responsável
    Dado um paciente menor com responsável configurado para receber mensagens
    Quando um lembrete é enviado
    Então ele vai para o responsável, não para o paciente

  Cenário: Acompanhante sem permissão
    Dado um acompanhante sem permissão de acesso a informações
    Quando ele pede informações à recepção pelo sistema
    Então nenhuma informação clínica é exibida para ele
```

### HU-PAC-003 — Deduplicação e mesclagem reversível
**WBS:** PAC-01.3 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PAC-001, HU-NUC-018 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Juliana**, quero ser avisada de possíveis duplicados e mesclá-los, para não espalhar o histórico de um paciente em duas fichas.

```gherkin
  Cenário: Alerta de duplicado
    Dado uma paciente "Maria Souza" nascida em 01/02/1980
    Quando Juliana cadastra outra "Maria Souza" com a mesma data
    Então o sistema alerta possível duplicado antes de salvar

  Cenário: Mesclagem preserva histórico
    Dado duas fichas duplicadas com atendimentos em cada uma
    Quando um admin as mescla
    Então todos os atendimentos, documentos e pagamentos ficam na ficha resultante

  Cenário: Reversão e auditoria
    Dado uma mesclagem feita há 10 dias
    Quando o admin a desfaz
    Então as duas fichas voltam ao estado anterior e ambas as ações constam na auditoria
```

### HU-PAC-004 — Busca e listagem de pacientes
**WBS:** PAC-02.1 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PAC-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Juliana**, quero buscar pacientes por nome parcial, telefone ou CPF, para achar a ficha em segundos durante uma ligação.

```gherkin
  Cenário: Busca sem acento e parcial
    Dado 100 mil pacientes cadastrados
    Quando Juliana digita "joao sil"
    Então "João da Silva" aparece em menos de 300 ms

  Cenário: Filtros combinados
    Dado pacientes de vários profissionais
    Quando ela filtra por profissional e último atendimento
    Então a lista mostra apenas os que atendem aos dois filtros
```

### HU-PAC-005 — Tags e segmentos sem diagnóstico
**WBS:** PAC-02.2 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PAC-004 · **Pontos:** 2 · **MoSCoW:** Should · **LGPD:** N

Como **Carla**, quero etiquetar pacientes e salvar segmentos, para organizar a operação sem expor diagnósticos.

```gherkin
  Cenário: Segmento salvo
    Dado pacientes com a tag "pacote-mensal"
    Quando Carla salva o filtro como segmento
    Então o segmento fica disponível na lista

  Cenário: Tag com termo clínico
    Dado a tentativa de criar a tag "depressão"
    Quando a validação encontra termo de diagnóstico
    Então o sistema bloqueia e orienta a não usar diagnóstico em tags
```

### HU-PAC-006 — Anexos administrativos
**WBS:** PAC-02.3 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-NUC-005 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** S

Como **Juliana**, quero anexar documentos de identificação e termos assinados pela câmera do tablet, para eliminar papel na recepção.

```gherkin
  Cenário: Upload pela câmera
    Dado Juliana no tablet da recepção
    Quando ela fotografa o documento na ficha do paciente
    Então o arquivo é salvo direto no sistema, sem passar pela galeria do aparelho

  Cenário: Acesso auditado
    Dado um anexo administrativo
    Quando qualquer usuário o abre
    Então o acesso é registrado na auditoria
```

### HU-PAC-007 — Linha do tempo do paciente filtrada por permissão
**WBS:** PAC-02.4 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PAC-001, HU-AGD-006, HU-NUC-016 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero ver em ordem cronológica agendamentos, atendimentos, documentos, pagamentos e mensagens do paciente, para ter contexto antes da consulta.

```gherkin
  Cenário: Profissional vê eventos clínicos
    Dado um paciente com atendimentos de Dr. Rafael
    Quando Dr. Rafael abre a linha do tempo
    Então vê eventos administrativos e clínicos

  Cenário: Recepção vê só administrativo
    Dado o mesmo paciente
    Quando Juliana abre a linha do tempo
    Então vê agendamentos e pagamentos, sem nenhum evento clínico

  Cenário: Sigilo entre profissionais
    Dado um atendimento de psicologia não compartilhado
    Quando a nutricionista abre a linha do tempo
    Então o atendimento aparece só como "atendimento – outro profissional", sem conteúdo
```

### HU-PAC-008 — Inativação respeitando a guarda legal
**WBS:** PAC-02.6 · **Marco:** M1 · **Frente:** LGPD · **Depende de:** HU-PAC-001, HU-LGP-006 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** S

Como **Carla**, quero inativar pacientes que não atendo mais sem apagar o prontuário, para limpar as listas e cumprir a guarda de 20 anos.

```gherkin
  Cenário: Paciente some das listas
    Dado um paciente inativado
    Quando Juliana busca pacientes
    Então ele não aparece por padrão, só com o filtro "inativos"

  Cenário: Exclusão física bloqueada
    Dado um paciente com prontuário
    Quando alguém tenta excluí-lo definitivamente
    Então o sistema impede e informa o prazo legal de guarda

  Cenário: Prontuário continua exportável
    Dado um paciente inativo
    Quando o profissional exporta o prontuário
    Então a exportação é gerada normalmente e auditada
```

## EP-07 — Agenda

### HU-AGD-001 — Grade de horários por profissional
**WBS:** AGD-01.1 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-NUC-002, HU-NUC-015 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **Diego (fisio)**, quero configurar minha disponibilidade por dia, unidade e sala com intervalos, para que só ofereçam horários em que estou livre.

```gherkin
  Cenário: Semana configurada rapidamente
    Dado um profissional novo
    Quando ele copia a segunda-feira para os demais dias úteis
    Então a semana fica pronta em menos de 3 minutos

  Cenário: Fuso respeitado
    Dado uma grade das 8h às 12h
    Quando a agenda é vista por um usuário em outro fuso
    Então os horários seguem o fuso da clínica
```

### HU-AGD-002 — Tipos de atendimento
**WBS:** AGD-01.2 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-AGD-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero definir tipos de atendimento com duração, preço, cor, modalidade e profissionais habilitados, para padronizar a agenda e a cobrança.

```gherkin
  Cenário: Duração e preço sugeridos
    Dado o tipo "Sessão de fisioterapia" com 50 min e R$ 150
    Quando Juliana agenda esse tipo
    Então o horário ocupa 50 min e o preço sugerido é R$ 150

  Cenário: Profissional não habilitado
    Dado um tipo habilitado só para Diego
    Quando Juliana tenta agendá-lo com outro profissional
    Então o sistema impede e explica o motivo
```

### HU-AGD-003 — Bloqueios e feriados
**WBS:** AGD-01.3 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-001, HU-INT-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Dr. Rafael**, quero bloquear férias e ter feriados pré-carregados, para não receber agendamentos em dias que não atendo.

```gherkin
  Cenário: Feriado nacional pré-carregado
    Dado o feriado de 7 de setembro
    Quando a agenda é aberta nessa data
    Então o dia aparece bloqueado por padrão

  Cenário: Bloqueio impede agendamento online
    Dado um bloqueio de férias
    Quando um paciente busca horário online nesse período
    Então nenhum horário é oferecido
```

### HU-AGD-004 — Salas e equipamentos sem conflito
**WBS:** AGD-01.4 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-NUC-002, HU-AGD-001 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero que a agenda impeça dois atendimentos na mesma sala ao mesmo tempo, para evitar conflitos na clínica.

```gherkin
  Cenário: Conflito de sala bloqueado
    Dado a "Sala 2" ocupada das 10h às 11h
    Quando Juliana agenda outro atendimento na "Sala 2" às 10h30
    Então o sistema bloqueia e mostra o conflito

  Cenário: Override explícito
    Dado o mesmo conflito
    Quando um admin confirma o override com motivo
    Então o agendamento é criado e o override fica registrado
```

### HU-AGD-005 — Visões de agenda
**WBS:** AGD-02.1 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-001 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **Juliana**, quero ver a agenda por dia, semana, mês e lista, com vários profissionais lado a lado, para encaixar pacientes rapidamente.

```gherkin
  Cenário: Desempenho com equipe
    Dado 10 profissionais com agenda cheia
    Quando Juliana abre a semana
    Então a tela carrega em menos de 1 segundo

  Cenário: Uso em tablet
    Dado um tablet de 10 polegadas
    Quando Juliana usa a visão de dia
    Então todos os controles são utilizáveis por toque
```

### HU-AGD-006 — Criar, mover e cancelar agendamentos
**WBS:** AGD-02.2 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-005, HU-PAC-001 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** N

Como **Juliana**, quero criar, arrastar, editar e cancelar agendamentos com validação de conflito, para manter a agenda correta sem retrabalho.

```gherkin
  Cenário: Mover arrastando
    Dado um agendamento às 9h
    Quando Juliana o arrasta para as 11h livre
    Então o horário muda e a alteração fica no histórico com autor

  Cenário: Conflito de profissional
    Dado Dr. Rafael ocupado às 14h
    Quando Juliana tenta agendar outro paciente às 14h
    Então o sistema bloqueia (salvo encaixe)

  Cenário: Cancelamento exige motivo
    Dado um agendamento futuro
    Quando Juliana o cancela sem informar motivo
    Então o sistema não permite concluir
```

### HU-AGD-007 — Encaixe
**WBS:** AGD-02.3 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-006 · **Pontos:** 2 · **MoSCoW:** Should · **LGPD:** N

Como **Juliana**, quero encaixar um paciente fora da grade com sinalização, para atender urgências sem bagunçar a agenda.

```gherkin
  Cenário: Encaixe sinalizado
    Dado um horário cheio
    Quando Juliana cria um encaixe
    Então ele aparece com marca visual de encaixe e conta separado nos relatórios

  Cenário: Limite de encaixes
    Dado o limite de 2 encaixes por dia para Dr. Rafael
    Quando Juliana tenta o terceiro
    Então o sistema bloqueia e informa o limite
```

### HU-AGD-008 — Sessões recorrentes vinculadas a pacote
**WBS:** AGD-02.4 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-006, HU-FIN-004 (no M1 usar contador de sessões; vínculo financeiro completo no M4) · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** N

Como **Marcos (psicólogo)**, quero criar uma série semanal ou quinzenal de sessões em uma ação, para não agendar uma por uma.

```gherkin
  Cenário: Série de 20 sessões
    Dado um paciente com pacote de 20 sessões
    Quando Marcos cria uma série semanal às quintas 18h
    Então 20 agendamentos são criados em uma ação, pulando feriados com aviso

  Cenário: Editar só esta ou todas as próximas
    Dado uma série em andamento
    Quando Marcos muda o horário escolhendo "todas as próximas"
    Então só as sessões futuras mudam e as passadas ficam intactas

  Cenário: Conflito em parte da série
    Dado que 2 das 20 datas têm conflito
    Quando a série é criada
    Então o sistema lista os conflitos e pede decisão antes de confirmar
```
> Núcleo comum às duas opções de D1 (sessões recorrentes).

### HU-AGD-009 — Lista de espera
**WBS:** AGD-02.5 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-006 · **Pontos:** 3 · **MoSCoW:** Should · **LGPD:** N

Como **Juliana**, quero manter uma lista de espera por profissional, serviço e período preferido, para ocupar vagas liberadas.

```gherkin
  Cenário: Candidatos compatíveis
    Dado 3 pacientes na lista de espera de Diego para manhãs
    Quando uma sessão de manhã é cancelada
    Então Juliana vê os 3 candidatos compatíveis em ordem de entrada

  Cenário: Saída da lista ao agendar
    Dado um paciente da lista
    Quando ele é agendado
    Então sai da lista automaticamente
```

### HU-AGD-010 — Status do atendimento e check-in
**WBS:** AGD-02.7 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-AGD-006 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **Juliana**, quero marcar chegada, atendimento, falta e cancelamento, para saber quem está esperando e medir faltas.

```gherkin
  Cenário: Fluxo válido de status
    Dado um agendamento "confirmado"
    Quando Juliana marca "chegou" e o profissional inicia o atendimento
    Então o status passa a "em atendimento" e o tempo de espera é calculado

  Cenário: Transição inválida
    Dado um agendamento "atendido"
    Quando alguém tenta marcá-lo como "faltou"
    Então o sistema recusa a transição

  Cenário: Falta alimenta relatório
    Dado um agendamento vencido sem chegada
    Quando Juliana marca "faltou"
    Então a falta entra na métrica de no-show
```

## EP-08 — Prontuário — núcleo

### HU-PRO-001 — Editor de modelos de prontuário
**WBS:** PRO-01.1 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-NUC-001 · **Pontos:** 13 · **MoSCoW:** Must · **LGPD:** N

Como **Lívia (nutricionista)**, quero montar meu modelo de prontuário arrastando campos, para registrar do meu jeito sem depender de suporte.

```gherkin
  Cenário: Modelo de 15 campos sem ajuda
    Dado uma profissional no editor
    Quando ela cria seções e 15 campos (texto, número, data, escolhas, tabela)
    Então conclui em menos de 10 minutos no teste de usabilidade

  Cenário: Imagem anotável
    Dado um campo de imagem anotável
    Quando a profissional marca pontos na imagem
    Então as marcações são salvas junto ao registro

  Cenário: Publicação valida campos
    Dado um modelo com campo sem rótulo
    Quando ela tenta publicar
    Então o sistema aponta o erro e impede a publicação
```

### HU-PRO-002 — Biblioteca de componentes clínicos
**WBS:** PRO-01.2 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-001, HU-INT-001 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** N

Como **Dr. Rafael**, quero inserir componentes prontos (sinais vitais, alergias, medicações, CID, queixa/HDA, conduta), para montar modelos rápido e com dados estruturados.

```gherkin
  Cenário: Componente CID usa base versionada
    Dado o componente CID no modelo
    Quando o profissional busca "diabetes"
    Então vê códigos da base CID vigente com a versão registrada

  Cenário: Catálogo mínimo
    Dado a biblioteca publicada
    Quando o catálogo é revisado
    Então há ≥ 20 componentes documentados e reutilizáveis
```

### HU-PRO-003 — Versionamento de modelos
**WBS:** PRO-01.4 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PRO-001 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** N

Como **Dr. Rafael**, quero alterar meus modelos sem mudar registros antigos, para preservar exatamente o que foi assinado.

```gherkin
  Cenário: Registro antigo inalterado
    Dado um registro assinado com a versão 1 do modelo
    Quando o modelo é alterado para a versão 2
    Então o registro antigo renderiza idêntico à versão 1

  Cenário: Novo registro usa versão atual
    Dado a versão 2 publicada
    Quando um atendimento novo é aberto
    Então ele usa a versão 2
```

### HU-PRO-004 — Publicação de modelos globais por nicho
**WBS:** ADM-01.5 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-003 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** N

Como **analista de produto interno**, quero publicar e versionar modelos padrão por nicho para todas as clínicas, para entregar conteúdo novo sem deploy.

```gherkin
  Cenário: Modelo disponível sem deploy
    Dado um novo modelo de fonoaudiologia aprovado
    Quando o analista o publica no backoffice
    Então todas as clínicas com o nicho veem o modelo na biblioteca

  Cenário: Clínica com cópia personalizada
    Dado uma clínica que personalizou o modelo global
    Quando uma nova versão global é publicada
    Então a cópia da clínica não é sobrescrita e ela é avisada da novidade
```

### HU-PRO-005 — Atendimento iniciado pela agenda com salvamento automático
**WBS:** PRO-02.1 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PRO-001, HU-AGD-010, HU-NUC-017 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero abrir o atendimento em 1 clique a partir da agenda, para registrar sem perder tempo nem texto.

```gherkin
  Cenário: Um clique da agenda
    Dado um paciente com status "chegou"
    Quando Dr. Rafael clica em "Iniciar atendimento"
    Então o registro abre no modelo padrão do tipo de atendimento e o cronômetro inicia

  Cenário: Salvamento automático
    Dado um registro em edição
    Quando a conexão cai após 25 segundos de digitação
    Então o conteúdo até os últimos 10 segundos está salvo ao reconectar

  Cenário: Sem vínculo de cuidado
    Dado um profissional que não é o assistente do agendamento
    Quando ele tenta iniciar o atendimento
    Então o acesso é negado e auditado
```

### HU-PRO-006 — Anamnese e antecedentes persistentes
**WBS:** PRO-02.2 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-005 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero que alergias, medicações e antecedentes já apareçam no próximo atendimento, para não perguntar tudo de novo.

```gherkin
  Cenário: Reaproveitamento com data
    Dado alergias registradas em março
    Quando um novo atendimento é aberto em junho
    Então as alergias aparecem com a indicação "atualizado em março"

  Cenário: Acesso restrito
    Dado Juliana com papel recepção
    Quando ela tenta ver os antecedentes pela ficha ou pela API
    Então a informação não é exibida e a tentativa é auditada
```

### HU-PRO-007 — Finalização, bloqueio e adendos
**WBS:** PRO-02.3 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PRO-005, HU-NUC-018 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Dr. Rafael**, quero finalizar o registro e depois só incluir adendos datados, para garantir a integridade legal do prontuário.

```gherkin
  Cenário: Registro finalizado não edita
    Dado um registro finalizado
    Quando qualquer usuário tenta editar o conteúdo (UI ou API)
    Então a edição é recusada

  Cenário: Adendo com autoria
    Dado um registro finalizado
    Quando Dr. Rafael adiciona um adendo
    Então o adendo aparece com autor, data e hora, abaixo do original

  Cenário: Evento da North Star
    Dado um atendimento vindo da agenda
    Quando o registro é finalizado
    Então o evento "encounter_record_signed" é emitido sem dado pessoal
```

### HU-PRO-008 — Anexos clínicos com visualizador
**WBS:** PRO-02.5 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-NUC-005, HU-PRO-005 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Lívia**, quero anexar exames e laudos ao atendimento e vê-los na própria tela, para analisar sem baixar arquivos.

```gherkin
  Cenário: Visualização inline
    Dado um PDF de exame anexado
    Quando Lívia o abre
    Então ele é exibido dentro do sistema, vinculado ao atendimento

  Cenário: Download controlado
    Dado um anexo clínico
    Quando um usuário sem vínculo de cuidado tenta baixá-lo
    Então o download é negado e auditado
```

### HU-PRO-009 — Anotações privadas do profissional `[nicho:psico]`
**WBS:** PRO-02.6 · **Marco:** M1 · **Frente:** LGPD · **Depende de:** HU-PRO-005, HU-NUC-017 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Marcos (psicólogo)**, quero anotações pessoais separadas do prontuário, para registrar impressões que não devem ser compartilhadas nem exportadas sem minha decisão.

```gherkin
  Cenário: Admin não acessa
    Dado uma anotação privada de Marcos
    Quando Carla (admin) tenta acessá-la por qualquer tela ou API
    Então o acesso é negado e auditado

  Cenário: Fora da exportação por padrão
    Dado uma exportação de prontuário do paciente
    Quando ela é gerada
    Então as anotações privadas não são incluídas, salvo decisão expressa de Marcos

  Cenário: Desativação do profissional
    Dado que Marcos deixa a clínica
    Quando a conta dele é desativada
    Então as anotações seguem a regra definida no RIPD e aprovada pelo Guardião
```
> Disponível para todos os nichos (núcleo); a tag marca onde é diferencial de venda. Mantida como Must por exigência de sigilo.

### HU-PRO-010 — Histórico clínico
**WBS:** PRO-02.7 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-PRO-005 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **Diego (fisio)**, quero ver o histórico clínico com filtros e comparar registros, para acompanhar a evolução do paciente.

```gherkin
  Cenário: Histórico longo rápido
    Dado 5 anos de registros de um paciente
    Quando Diego abre o histórico
    Então ele carrega em menos de 2 segundos

  Cenário: Filtro respeita sigilo
    Dado registros de vários profissionais
    Quando Diego filtra por "todos os profissionais"
    Então só vê registros próprios ou compartilhados com ele
```

## EP-09 — Prontuário por nicho

> Os pacotes de modelos dividem a microparte PRO-01.3 por nicho (cada um com ≥ 2 modelos revisados por profissional do nicho). São os itens a reordenar após a decisão D1: os pacotes dos nichos escolhidos sobem para **Must**.

### HU-PRO-011 — Seleção de modelos por nicho no onboarding
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-NUC-020, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Must · **LGPD:** N

Como **Carla**, quero escolher os modelos dos nichos da minha clínica durante o onboarding, para que cada profissional já encontre o seu.

```gherkin
  Cenário: Modelos por profissional
    Dado uma clínica com psicólogo e nutricionista
    Quando Carla conclui o onboarding
    Então cada profissional vê como padrão os modelos do próprio nicho

  Cenário: Nicho sem pacote publicado
    Dado um nicho ainda sem pacote de modelos
    Quando ele é escolhido
    Então o sistema oferece o modelo genérico e o editor
```

### HU-PRO-012 — Modelos prontos de medicina `[nicho:medicina]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 3 · **MoSCoW:** Should · **LGPD:** N

Como **Dr. Rafael**, quero modelos prontos de clínica geral, pediatria e endocrinologia, para começar a atender sem montar nada.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de medicina
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por médico, com anamnese, exame físico, CID e conduta

  Cenário: Ativo após onboarding
    Dado uma clínica com nicho medicina
    Quando ela conclui o onboarding
    Então os modelos de medicina já estão ativos
```

### HU-PRO-013 — Modelos prontos de psicologia `[nicho:psico]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Should · **LGPD:** N

Como **Marcos**, quero modelos de anamnese psicológica e evolução de sessão alinhados às orientações do CFP, para registrar de forma padronizada.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de psicologia
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por psicólogo (anamnese, evolução de sessão)

  Cenário: Padrão nas sessões recorrentes
    Dado uma sessão recorrente de psicologia
    Quando Marcos inicia o atendimento
    Então o modelo de evolução de sessão abre por padrão
```

### HU-PRO-014 — Modelos prontos de nutrição `[nicho:nutri]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Should · **LGPD:** N

Como **Lívia**, quero modelos de primeira consulta e retorno nutricional, para atender com antropometria e hábitos já estruturados.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de nutrição
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por nutricionista com o componente de antropometria

  Cenário: Retorno puxa medidas anteriores
    Dado um retorno nutricional
    Quando Lívia abre o modelo
    Então as últimas medidas aparecem para comparação
```

### HU-PRO-015 — Modelos prontos de fisioterapia e TO `[nicho:fisio-to]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Should · **LGPD:** N

Como **Diego**, quero modelos de avaliação fisioterapêutica e evolução de sessão, para registrar rápido entre um paciente e outro.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de fisio/TO
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por fisioterapeuta/TO com EVA e goniometria

  Cenário: Evolução curta
    Dado uma sessão do plano
    Quando Diego abre a evolução de sessão
    Então o modelo cabe em uma tela de tablet
```

### HU-PRO-016 — Modelos prontos de fonoaudiologia e TEA `[nicho:fono-tea]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 3 · **MoSCoW:** Should · **LGPD:** N

Como **Renata**, quero modelos de avaliação fonoaudiológica e de registro de sessão para TEA, para documentar metas e evolução da criança.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de fono/TEA
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por fonoaudiólogo, com campos de metas por sessão

  Cenário: Responsável visível no cabeçalho
    Dado um paciente menor
    Quando Renata abre o registro
    Então o cabeçalho mostra o responsável legal
```

### HU-PRO-017 — Modelos prontos de odontologia `[nicho:odonto]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Could · **LGPD:** N

Como **Dra. Bianca**, quero modelos de anamnese odontológica e evolução clínica, para usar junto com o odontograma.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de odontologia
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por dentista com o odontograma embutido

  Cenário: Ativo após onboarding
    Dado uma clínica com nicho odonto
    Quando ela conclui o onboarding
    Então os modelos de odontologia estão ativos
```

### HU-PRO-018 — Modelos prontos de estética `[nicho:estetica]`
**WBS:** PRO-01.3 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002, HU-PRO-004 · **Pontos:** 2 · **MoSCoW:** Could · **LGPD:** N

Como **Dra. Paula**, quero modelos de avaliação estética e registro de procedimento, para padronizar os atendimentos.

```gherkin
  Cenário: Modelos revisados
    Dado o pacote de estética
    Quando ele é publicado
    Então contém ≥ 2 modelos revisados por profissional de estética habilitado

  Cenário: Sem promessa de resultado
    Dado o texto padrão dos modelos
    Quando a revisão de conteúdo é feita
    Então não há frases de promessa de resultado (regras de publicidade dos conselhos)
```

### HU-PRO-019 — Odontograma básico `[nicho:odonto]`
**WBS:** PRO-03.1 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-005 · **Pontos:** 8 · **MoSCoW:** Could · **LGPD:** S

Como **Dra. Bianca**, quero marcar estados por dente e face na dentição permanente e decídua, para registrar a condição bucal com histórico.

```gherkin
  Cenário: Registro por face em 2 cliques
    Dado o odontograma aberto
    Quando Dra. Bianca seleciona o dente 36, face oclusal, estado "cárie"
    Então o registro é feito em no máximo 2 cliques com a legenda padrão

  Cenário: Histórico do dente
    Dado registros em datas diferentes
    Quando ela abre o histórico do dente 36
    Então vê a sequência de estados com data e autor

  Cenário: Acesso clínico restrito
    Dado Juliana com papel recepção
    Quando ela tenta abrir o odontograma
    Então o acesso é negado e auditado
```

### HU-PRO-020 — Antropometria com gráficos de evolução `[nicho:nutri]`
**WBS:** PRO-03.4 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-005 · **Pontos:** 5 · **MoSCoW:** Should · **LGPD:** S

Como **Lívia**, quero registrar peso, altura, circunferências e dobras com cálculo automático de IMC e % de gordura, para acompanhar a evolução em gráficos.

```gherkin
  Cenário: Cálculos de referência
    Dado os casos de referência do protocolo escolhido
    Quando as medidas são registradas
    Então IMC e % de gordura batem com os valores esperados

  Cenário: Gráfico por medida
    Dado 5 consultas com medidas
    Quando Lívia abre a evolução
    Então vê um gráfico por medida ao longo do tempo

  Cenário: Dados fora do vínculo de cuidado
    Dado outro profissional sem compartilhamento
    Quando ele tenta abrir as medidas do paciente
    Então o acesso é negado e auditado
```

### HU-PRO-021 — Plano de sessões com metas `[nicho:fisio-to]` `[nicho:fono-tea]` `[nicho:psico]`
**WBS:** PRO-03.7 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-005, HU-AGD-008 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **Diego**, quero um plano terapêutico com nº de sessões, metas e evolução por sessão ligado ao pacote e à agenda, para ver o progresso e o saldo de sessões.

```gherkin
  Cenário: Sessão decrementa saldo
    Dado um plano de 10 sessões com 4 realizadas
    Quando a 5ª sessão é finalizada
    Então o saldo passa a 5 restantes

  Cenário: Progresso de metas
    Dado metas com indicador por sessão
    Quando Diego registra a evolução
    Então o percentual de progresso de cada meta é atualizado

  Cenário: Saldo esgotado
    Dado um plano sem sessões restantes
    Quando Juliana agenda nova sessão vinculada
    Então o sistema avisa que o plano acabou e sugere renovação
```
> Núcleo comum às duas opções de D1; por isso Must mesmo com tag.

### HU-PRO-022 — EVA de dor e goniometria `[nicho:fisio-to]`
**WBS:** PRO-03.8 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-002 · **Pontos:** 3 · **MoSCoW:** Must · **LGPD:** S

Como **Diego**, quero registrar EVA de dor e goniometria com gráfico, para medir a melhora do paciente.

```gherkin
  Cenário: EVA registrada
    Dado o componente EVA
    Quando o paciente indica dor 7
    Então o valor é salvo e aparece no gráfico de evolução

  Cenário: Goniometria com referência
    Dado a medição de flexão de joelho
    Quando Diego registra 95°
    Então o sistema mostra a faixa de referência e a variação desde a última sessão

  Cenário: Medidas fora do vínculo de cuidado
    Dado um usuário com papel financeiro
    Quando ele requisita as medidas de EVA do paciente pela API
    Então recebe 403 e a tentativa é auditada
```

### HU-PRO-023 — Escalas e testes padronizados de domínio público `[nicho:fisio-to]` `[nicho:fono-tea]`
**WBS:** PRO-03.8 · **Marco:** M1 · **Frente:** Produto · **Depende de:** HU-PRO-022 · **Pontos:** 5 · **MoSCoW:** Should · **LGPD:** S

Como **Renata**, quero aplicar escalas e questionários de domínio público com escore automático, para medir a evolução com instrumentos reconhecidos.

```gherkin
  Cenário: Escore automático
    Dado uma escala de domínio público respondida
    Quando o profissional conclui
    Então o escore é calculado e confere com o caso de referência

  Cenário: Licença verificada
    Dado uma escala cuja licença não foi verificada
    Quando o catálogo é publicado
    Então a escala não aparece (escalas licenciadas ficam para F2)

  Cenário: Questionário respondido pelo responsável
    Dado um questionário enviado ao responsável de uma criança
    Quando outra pessoa abre o link após a expiração ou fora do vínculo
    Então o acesso é negado e nenhuma resposta anterior é exibida
```
> Corte pré-acordado do roadmap §8: "PRO-03.8 exceto EVA" pode ir para F2.

## EP-10 — Gate LGPD (consentimento, retenção, RIPD)

### HU-LGP-005 — Gestão de consentimentos granulares
**WBS:** LGP-01.2 · **Marco:** M1 · **Frente:** Engenharia · **Depende de:** HU-LGP-001, HU-PAC-001 · **Pontos:** 8 · **MoSCoW:** Must · **LGPD:** S

Como **paciente (Ana)**, quero dar e revogar consentimentos separados (gravação/escriba, imagem, marketing, compartilhamento), para controlar o uso dos meus dados.

```gherkin
  Cenário: Evidência versionada
    Dado o termo de gravação versão 1.2
    Quando Ana consente
    Então ficam registrados versão, data/hora, canal e quem coletou

  Cenário: Revogação imediata
    Dado Ana com consentimento de gravação ativo
    Quando ela revoga
    Então a próxima tentativa de gravar é bloqueada imediatamente

  Cenário: Funcionalidade sem consentimento
    Dado um paciente sem consentimento de imagem
    Quando o profissional tenta capturar foto clínica pela API
    Então o servidor recusa a ação e orienta a coletar o consentimento
```

### HU-LGP-006 — Tabela de temporalidade e descarte automático
**WBS:** LGP-03.3 · **Marco:** M1 · **Frente:** LGPD · **Depende de:** HU-LGP-001, HU-NUC-007 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **encarregado (DPO) da clínica**, quero que cada tipo de dado tenha prazo de retenção e descarte automático evidenciado, para não guardar dados além do necessário.

```gherkin
  Cenário: Descarte evidenciado
    Dado um tipo de dado com prazo vencido (ex.: ticket de suporte)
    Quando o job de descarte roda
    Então os dados são eliminados e uma evidência (contagem, data, tipo) é registrada

  Cenário: Prontuário preservado
    Dado um prontuário com menos de 20 anos
    Quando o job roda
    Então o prontuário não é tocado
```

### HU-LGP-007 — RIPD do produto aprovado (Gate LGPD)
**WBS:** LGP-03.2 · **Marco:** M1 · **Frente:** LGPD · **Depende de:** HU-LGP-004, HU-LGP-005, HU-LGP-006 · **Pontos:** 5 · **MoSCoW:** Must · **LGPD:** S

Como **sócio (N0)**, quero o RIPD do produto aprovado pelo Guardião antes de qualquer dado real, para liberar o piloto com segurança jurídica.

```gherkin
  Cenário: Gate bloqueia dado real
    Dado o RIPD do produto ainda não aprovado
    Quando se tenta habilitar produção para uma clínica piloto
    Então a flag "dados_reais" permanece desligada

  Cenário: Gate aprovado
    Dado RIPD aprovado, pentest sem achado crítico/alto e tabletop de incidente realizado
    Quando Guardião e sócios assinam a ata
    Então a flag "dados_reais" pode ser ligada para clínicas com DPA aceito
```
> O RIPD específico do escriba (também LGP-03.2) é gate do M3 — ver HU-IA-013.

---

# Marcos M2–M4 — histórias listadas (Gherkin no refinamento)

> Formato da linha: ID · título · IDs WBS · pontos · MoSCoW · flag LGPD · tags. Frente dona, dependências e critério de pronto de cada microparte estão na [WBS](./WBS-micropartes.md). Antes de entrar na iteração, cada história recebe a frase "Como/quero/para" e o Gherkin conforme o [DoR](./definicao-de-pronto.md).

## Marco M2 — WhatsApp first

### EP-11 — WhatsApp e comunicação

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-COM-001 | Conectar o número oficial da clínica ao WhatsApp Business Platform | COM-01.1 | 8 | Must | N | |
| HU-COM-002 | Gerir templates aprovados sem conteúdo clínico | COM-01.2 | 5 | Must | N | |
| HU-COM-003 | Opt-in e preferências de canal do paciente | COM-01.3 | 3 | Must | N | |
| HU-COM-004 | Status de entrega e retentativas | COM-01.4 | 3 | Must | N | |
| HU-COM-005 | Painel de qualidade do número e custo por conversa | COM-01.5 | 3 | Should | N | |
| HU-COM-006 | Inbox multiatendente da recepção | COM-02.1 | 13 | Must | S | |
| HU-COM-007 | Painel de contexto do paciente na conversa (só administrativo para recepção) | COM-02.2 | 5 | Must | S | |
| HU-COM-008 | Respostas rápidas e envio de mídia | COM-02.3 | 3 | Must | S | |
| HU-COM-009 | Notas internas e transferência de conversa | COM-02.4 | 3 | Must | N | |
| HU-COM-010 | Lembretes automáticos de consulta | COM-03.1 | 5 | Must | N | |
| HU-COM-011 | Confirmação interativa com regras por tipo de atendimento | COM-03.2, AGD-03.1 | 8 | Must | N | |
| HU-COM-012 | Instruções de preparo e link de pré-cadastro pelo WhatsApp | COM-03.3, PAC-01.4 | 5 | Must | S | |
| HU-COM-013 | E-mail e SMS transacionais como canal alternativo | COM-04.1, COM-04.2 | 5 | Must | N | |
| HU-COM-014 | Motor de templates multicanal | COM-04.4 | 5 | Must | N | |
| HU-AGD-011 | Paciente remarca ou cancela sozinho respeitando antecedência | AGD-03.2 | 5 | Must | N | |

### EP-12 — Agendamento online e bot

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-AON-001 | Página pública da clínica e do profissional | AON-01.1 | 5 | Must | N | |
| HU-AON-002 | Seleção de horário online | AON-01.2 | 5 | Must | N | |
| HU-AON-003 | Identificação do paciente no agendamento online | AON-01.3 | 5 | Must | S | |
| HU-AON-004 | Widget e links de agendamento para site e Instagram | AON-01.5 | 2 | Could | N | |
| HU-AON-005 | Proteção anti-abuso no agendamento online | AON-01.7 | 3 | Must | N | |
| HU-AON-006 | Bot conversacional de agendamento no WhatsApp | AON-02.1, IA-04.1 | 13 | Must | N | |
| HU-AON-007 | Regras de autoagendamento por tipo e profissional | AON-02.2 | 3 | Must | N | |
| HU-AON-008 | Handoff do bot para atendente humano | AON-02.3 | 3 | Must | N | |
| HU-IA-001 | Guardrails do bot (sem orientação clínica, sem dado sensível) | IA-04.3 | 5 | Must | S | |

## Marco M3 — Documentos e escriba

### EP-13 — Documentos clínicos e assinatura

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-DOC-001 | Receituário simples com base de medicamentos | DOC-01.1 | 8 | Must | S | `[nicho:medicina]` `[nicho:odonto]` |
| HU-DOC-002 | Receita de controle especial | DOC-01.2 | 8 | Should | S | `[nicho:medicina]` |
| HU-DOC-003 | Atestados e declarações de comparecimento | DOC-01.3 | 3 | Must | S | |
| HU-DOC-004 | Pedidos de exame e encaminhamentos | DOC-01.4 | 3 | Should | S | `[nicho:medicina]` |
| HU-DOC-005 | Modelos de documentos da clínica | DOC-01.5 | 3 | Could | S | |
| HU-DOC-006 | Assinatura ICP-Brasil em nuvem | DOC-02.1 | 13 | Must | S | |
| HU-DOC-007 | Verificação pública de autenticidade do documento | DOC-02.3 | 3 | Must | N | |
| HU-DOC-008 | Assinatura eletrônica do paciente | DOC-02.4 | 5 | Must | S | |
| HU-DOC-009 | Envio seguro ao paciente e impressão | DOC-03.1, DOC-03.2 | 5 | Must | S | |
| HU-PRO-024 | Fotos clínicas antes/depois com consentimento de imagem | PRO-03.9 | 8 | Could | S | `[nicho:estetica]` |
| HU-PRO-025 | Termo de consentimento (TCLE) por procedimento | PRO-03.13 | 5 | Should | S | `[nicho:estetica]` `[nicho:odonto]` |

### EP-14 — Escriba e IA clínica

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-IA-002 | Gateway de inferência com pseudonimização e dados no Brasil | IA-05.1 | 8 | Must | S | |
| HU-IA-003 | RAG isolado por tenant | IA-05.2 | 8 | Must | S | |
| HU-IA-004 | Captura de áudio da consulta com consentimento | IA-01.1 | 5 | Must | S | |
| HU-IA-005 | Transcrição clínica em pt-BR | IA-01.2 | 8 | Must | S | |
| HU-IA-006 | Rascunho estruturado no modelo do nicho | IA-01.3 | 13 | Must | S | |
| HU-IA-007 | Tela de revisão humana obrigatória antes de assinar | IA-01.4 | 5 | Must | S | |
| HU-IA-008 | Retenção e descarte do áudio | IA-01.5 | 3 | Must | S | |
| HU-IA-009 | Resumo do histórico do paciente | IA-02.1 | 5 | Should | S | |
| HU-IA-010 | Sugestão de CID opcional e justificada | IA-02.2 | 5 | Should | S | |
| HU-IA-011 | Avaliação contínua com golden sets por nicho (gate do escriba) | IA-05.3 | 8 | Must | N | golden set por nicho segue D1 |
| HU-IA-012 | Monitoramento de qualidade, custo e latência da IA | IA-05.6 | 3 | Must | N | |
| HU-IA-013 | RIPD específico do escriba aprovado | LGP-03.2 | 3 | Must | S | |

## Marco M4 — Receber e lançar

### EP-15 — Financeiro e repasse

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-FIN-001 | Cobrança gerada a partir do atendimento | FIN-01.1 | 5 | Must | N | |
| HU-FIN-002 | Caixa diário e formas de pagamento | FIN-01.2, FIN-01.3 | 5 | Must | N | |
| HU-FIN-003 | Recibo para reembolso e IR (Receita Saúde) | FIN-01.4 | 3 | Must | S | |
| HU-FIN-004 | Pacotes e créditos de sessões | FIN-01.5 | 5 | Must | N | |
| HU-FIN-005 | Regras e fechamento de repasse por profissional | FIN-03.1, FIN-03.2 | 8 | Must | N | |

### EP-16 — Pagamentos (Pix e cartão)

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-PAG-001 | Conta da clínica no PSP (onboarding KYC) | PAG-01.1 | 8 | Must | S | depende de D5 |
| HU-PAG-002 | Cobrança Pix imediata com baixa automática | PAG-01.2, PAG-01.4 | 8 | Must | N | |
| HU-PAG-003 | Devolução de Pix | PAG-01.5 | 3 | Must | N | |
| HU-PAG-004 | Link de pagamento e cartão online | PAG-02.1, PAG-02.2 | 8 | Must | S | |
| HU-PAG-005 | Conciliação automática de recebimentos | PAG-03.2 | 5 | Must | N | |

### EP-17 — Fiscal (NFS-e)

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-FIS-001 | Integração com agregador de NFS-e e configuração fiscal | FIS-01.1, FIS-01.2 | 8 | Must | S | |
| HU-FIS-002 | Emissão manual e automática com descrição minimizada (sem diagnóstico) | FIS-01.3, FIS-01.6 | 5 | Must | S | |
| HU-FIS-003 | Cancelamento, substituição e envio ao tomador | FIS-01.4, FIS-01.5 | 3 | Must | N | |

### EP-18 — Portal do paciente

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-POR-001 | Login sem senha e acesso de dependentes | POR-01.1, POR-01.2 | 8 | Must | S | |
| HU-POR-002 | Minhas consultas e meus pagamentos | POR-02.1, POR-02.3 | 5 | Must | N | |
| HU-POR-003 | Meus documentos | POR-02.2 | 3 | Must | S | |
| HU-POR-004 | Termos, consentimentos e central de privacidade | POR-02.5, POR-02.6 | 5 | Must | S | |
| HU-POR-005 | Portal instalável (PWA) | POR-03.1 | 3 | Should | N | |

### EP-19 — Direitos do titular e prontidão LGPD para GA

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-LGP-008 | Fluxo de solicitações de direitos do titular com protocolo e prazo | LGP-02.1 | 5 | Must | S | |
| HU-LGP-009 | Fila da clínica para responder solicitações | LGP-02.2 | 5 | Must | S | |
| HU-LGP-010 | Eliminação, anonimização e bloqueio até o fim da guarda | LGP-02.3 | 8 | Must | S | |
| HU-LGP-011 | Plano de resposta a incidentes testado (comunicação em 3 dias úteis) | LGP-03.4 | 5 | Must | S | |
| HU-LGP-012 | Salvaguardas de transferência internacional de suboperadores | LGP-03.8 | 3 | Must | S | depende de D3 |

### EP-20 — Migração e exportação

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-MIG-001 | Importar pacientes por planilha | MIG-01.1 | 5 | Must | S | |
| HU-MIG-002 | Importar agenda futura | MIG-01.2 | 3 | Must | N | |
| HU-MIG-003 | Importador do concorrente A | MIG-01.3 | 8 | Must | S | |
| HU-MIG-004 | Importador do concorrente B | MIG-01.4 | 8 | Could | S | |
| HU-MIG-005 | Importação de anexos em massa | MIG-01.6 | 5 | Should | S | |
| HU-MIG-006 | Dry-run, relatório de divergências e rollback da migração | MIG-02.1, MIG-02.2 | 8 | Must | S | |
| HU-MIG-007 | Painel de migração assistida com termo e segurança | MIG-02.3, MIG-02.4 | 5 | Must | S | |
| HU-EXP-001 | Exportação total em formato aberto, protegida | EXP-01.1, EXP-01.5 | 8 | Must | S | |
| HU-EXP-002 | Exportar o prontuário individual de um paciente | EXP-01.3 | 3 | Must | S | |
| HU-EXP-003 | Saída da plataforma sem dados reféns | EXP-01.6 | 3 | Must | S | |

### EP-21 — Billing da plataforma

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-BIL-001 | Catálogo de planos e trial | BIL-01.1, BIL-01.2 | 5 | Must | N | depende de D2 |
| HU-BIL-002 | Assinatura recorrente e medição de uso | BIL-01.3, BIL-01.4 | 8 | Must | N | |
| HU-BIL-003 | Upgrade e downgrade de plano | BIL-01.5 | 3 | Must | N | |
| HU-BIL-004 | Faturas e NFS-e da plataforma | BIL-01.6 | 3 | Must | N | |
| HU-BIL-005 | Dunning e suspensão sem bloquear o acesso ao prontuário | BIL-01.7 | 5 | Must | N | |
| HU-BIL-006 | Cancelamento self-service | BIL-01.9 | 3 | Must | N | |

### EP-22 — Relatórios, NPS e métricas

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-REL-001 | Relatórios de ocupação, no-show e cancelamentos | REL-01.1, REL-01.2 | 5 | Must | N | |
| HU-REL-002 | Produção por profissional | REL-01.3 | 3 | Should | N | |
| HU-REL-003 | Faturamento e dashboard do gestor | REL-02.1, REL-03.1 | 8 | Must | N | |
| HU-CRM-001 | Pós-consulta e pesquisa NPS com painel | COM-03.4, CRM-01.1, CRM-01.2 | 8 | Should | S | |
| HU-CRM-002 | Registro da origem do paciente | CRM-02.1 | 2 | Could | N | |
| HU-ADM-003 | Métricas de negócio e North Star semanal | ADM-01.6 | 5 | Must | N | |

### EP-23 — Suporte e backoffice

| ID | Título | WBS | Pts | MoSCoW | LGPD | Tags |
|---|---|---|---|---|---|---|
| HU-SUP-001 | Central de ajuda por módulo e nicho | SUP-01.1 | 5 | Must | N | |
| HU-SUP-002 | Chat de suporte com mascaramento de dados de saúde | SUP-01.2, SUP-01.3 | 8 | Must | S | |
| HU-SUP-003 | Onboarding guiado (checklist de ativação e tours) | SUP-01.4 | 3 | Should | N | |
| HU-ADM-004 | Impersonação auditada com autorização do cliente | ADM-01.2 | 5 | Must | S | |
| HU-ADM-005 | Gestão de atualizações das bases de referência | ADM-01.4 | 3 | Must | N | |

---

## Rastreabilidade WBS → histórias

As 186 micropartes MVP da WBS estão cobertas por ao menos uma história (conferido em 2026-10-08).

| Microparte | Dado sensível | História(s) |
|---|---|---|
| NUC-01.1 | S | HU-NUC-001 |
| NUC-01.2 | N | HU-NUC-020 |
| NUC-01.3 | N | HU-NUC-002 |
| NUC-01.4 | N | HU-NUC-003 |
| NUC-02.1 | N | HU-NUC-011 |
| NUC-02.2 | S | HU-NUC-012 |
| NUC-02.3 | S | HU-NUC-013 |
| NUC-02.4 | N | HU-NUC-014 |
| NUC-02.6 | N | HU-NUC-015 |
| NUC-03.1 | S | HU-NUC-016 |
| NUC-03.3 | S | HU-NUC-017 |
| NUC-04.1 | S | HU-NUC-018 |
| NUC-04.2 | S | HU-NUC-019 |
| NUC-05.1 | S | HU-NUC-004 |
| NUC-05.2 | S | HU-NUC-005 |
| NUC-05.3 | N | HU-NUC-006 |
| NUC-05.4 | N | HU-NUC-007 |
| NUC-05.5 | N | HU-NUC-008 |
| NUC-05.6 | S | HU-NUC-009 |
| NUC-05.7 | N | HU-NUC-010 |
| PAC-01.1 | S | HU-PAC-001 |
| PAC-01.2 | S | HU-PAC-002 |
| PAC-01.3 | S | HU-PAC-003 |
| PAC-01.4 | S | HU-COM-012 |
| PAC-02.1 | N | HU-PAC-004 |
| PAC-02.2 | N | HU-PAC-005 |
| PAC-02.3 | S | HU-PAC-006 |
| PAC-02.4 | S | HU-PAC-007 |
| PAC-02.6 | S | HU-PAC-008 |
| AGD-01.1 | N | HU-AGD-001 |
| AGD-01.2 | N | HU-AGD-002 |
| AGD-01.3 | N | HU-AGD-003 |
| AGD-01.4 | N | HU-AGD-004 |
| AGD-02.1 | N | HU-AGD-005 |
| AGD-02.2 | N | HU-AGD-006 |
| AGD-02.3 | N | HU-AGD-007 |
| AGD-02.4 | N | HU-AGD-008 |
| AGD-02.5 | N | HU-AGD-009 |
| AGD-02.7 | N | HU-AGD-010 |
| AGD-03.1 | N | HU-COM-011 |
| AGD-03.2 | N | HU-AGD-011 |
| AON-01.1 | N | HU-AON-001 |
| AON-01.2 | N | HU-AON-002 |
| AON-01.3 | S | HU-AON-003 |
| AON-01.5 | N | HU-AON-004 |
| AON-01.7 | N | HU-AON-005 |
| AON-02.1 | N | HU-AON-006 |
| AON-02.2 | N | HU-AON-007 |
| AON-02.3 | N | HU-AON-008 |
| COM-01.1 | N | HU-COM-001 |
| COM-01.2 | N | HU-COM-002 |
| COM-01.3 | N | HU-COM-003 |
| COM-01.4 | N | HU-COM-004 |
| COM-01.5 | N | HU-COM-005 |
| COM-02.1 | S | HU-COM-006 |
| COM-02.2 | S | HU-COM-007 |
| COM-02.3 | S | HU-COM-008 |
| COM-02.4 | N | HU-COM-009 |
| COM-03.1 | N | HU-COM-010 |
| COM-03.2 | N | HU-COM-011 |
| COM-03.3 | N | HU-COM-012 |
| COM-03.4 | S | HU-CRM-001 |
| COM-04.1 | N | HU-COM-013 |
| COM-04.2 | N | HU-COM-013 |
| COM-04.4 | N | HU-COM-014 |
| PRO-01.1 | N | HU-PRO-001 |
| PRO-01.2 | N | HU-PRO-002 |
| PRO-01.3 | N | HU-PRO-011, HU-PRO-012, HU-PRO-013, HU-PRO-014, HU-PRO-015, HU-PRO-016, HU-PRO-017, HU-PRO-018 |
| PRO-01.4 | N | HU-PRO-003 |
| PRO-02.1 | S | HU-PRO-005 |
| PRO-02.2 | S | HU-PRO-006 |
| PRO-02.3 | S | HU-PRO-007 |
| PRO-02.5 | S | HU-PRO-008 |
| PRO-02.6 | S | HU-PRO-009 |
| PRO-02.7 | S | HU-PRO-010 |
| PRO-03.1 | S | HU-PRO-019 |
| PRO-03.4 | S | HU-PRO-020 |
| PRO-03.7 | S | HU-PRO-021 |
| PRO-03.8 | S | HU-PRO-022, HU-PRO-023 |
| PRO-03.9 | S | HU-PRO-024 |
| PRO-03.13 | S | HU-PRO-025 |
| DOC-01.1 | S | HU-DOC-001 |
| DOC-01.2 | S | HU-DOC-002 |
| DOC-01.3 | S | HU-DOC-003 |
| DOC-01.4 | S | HU-DOC-004 |
| DOC-01.5 | S | HU-DOC-005 |
| DOC-02.1 | S | HU-DOC-006 |
| DOC-02.3 | N | HU-DOC-007 |
| DOC-02.4 | S | HU-DOC-008 |
| DOC-03.1 | S | HU-DOC-009 |
| DOC-03.2 | S | HU-DOC-009 |
| FIN-01.1 | N | HU-FIN-001 |
| FIN-01.2 | N | HU-FIN-002 |
| FIN-01.3 | N | HU-FIN-002 |
| FIN-01.4 | S | HU-FIN-003 |
| FIN-01.5 | N | HU-FIN-004 |
| FIN-03.1 | N | HU-FIN-005 |
| FIN-03.2 | N | HU-FIN-005 |
| PAG-01.1 | S | HU-PAG-001 |
| PAG-01.2 | N | HU-PAG-002 |
| PAG-01.4 | N | HU-PAG-002 |
| PAG-01.5 | N | HU-PAG-003 |
| PAG-02.1 | N | HU-PAG-004 |
| PAG-02.2 | S | HU-PAG-004 |
| PAG-03.2 | N | HU-PAG-005 |
| FIS-01.1 | N | HU-FIS-001 |
| FIS-01.2 | S | HU-FIS-001 |
| FIS-01.3 | N | HU-FIS-002 |
| FIS-01.4 | N | HU-FIS-003 |
| FIS-01.5 | N | HU-FIS-003 |
| FIS-01.6 | S | HU-FIS-002 |
| CRM-01.1 | N | HU-CRM-001 |
| CRM-01.2 | N | HU-CRM-001 |
| CRM-02.1 | N | HU-CRM-002 |
| REL-01.1 | N | HU-REL-001 |
| REL-01.2 | N | HU-REL-001 |
| REL-01.3 | N | HU-REL-002 |
| REL-02.1 | N | HU-REL-003 |
| REL-03.1 | N | HU-REL-003 |
| POR-01.1 | S | HU-POR-001 |
| POR-01.2 | S | HU-POR-001 |
| POR-02.1 | N | HU-POR-002 |
| POR-02.2 | S | HU-POR-003 |
| POR-02.3 | N | HU-POR-002 |
| POR-02.5 | S | HU-POR-004 |
| POR-02.6 | S | HU-POR-004 |
| POR-03.1 | N | HU-POR-005 |
| IA-01.1 | S | HU-IA-004 |
| IA-01.2 | S | HU-IA-005 |
| IA-01.3 | S | HU-IA-006 |
| IA-01.4 | S | HU-IA-007 |
| IA-01.5 | S | HU-IA-008 |
| IA-02.1 | S | HU-IA-009 |
| IA-02.2 | S | HU-IA-010 |
| IA-04.1 | N | HU-AON-006 |
| IA-04.3 | S | HU-IA-001 |
| IA-05.1 | S | HU-IA-002 |
| IA-05.2 | S | HU-IA-003 |
| IA-05.3 | N | HU-IA-011 |
| IA-05.6 | N | HU-IA-012 |
| INT-01.4 | N | HU-INT-001 |
| MIG-01.1 | S | HU-MIG-001 |
| MIG-01.2 | N | HU-MIG-002 |
| MIG-01.3 | S | HU-MIG-003 |
| MIG-01.4 | S | HU-MIG-004 |
| MIG-01.6 | S | HU-MIG-005 |
| MIG-02.1 | S | HU-MIG-006 |
| MIG-02.2 | S | HU-MIG-006 |
| MIG-02.3 | N | HU-MIG-007 |
| MIG-02.4 | S | HU-MIG-007 |
| EXP-01.1 | S | HU-EXP-001 |
| EXP-01.3 | S | HU-EXP-002 |
| EXP-01.5 | S | HU-EXP-001 |
| EXP-01.6 | S | HU-EXP-003 |
| BIL-01.1 | N | HU-BIL-001 |
| BIL-01.2 | N | HU-BIL-001 |
| BIL-01.3 | N | HU-BIL-002 |
| BIL-01.4 | N | HU-BIL-002 |
| BIL-01.5 | N | HU-BIL-003 |
| BIL-01.6 | N | HU-BIL-004 |
| BIL-01.7 | N | HU-BIL-005 |
| BIL-01.9 | N | HU-BIL-006 |
| ADM-01.1 | N | HU-ADM-001 |
| ADM-01.2 | S | HU-ADM-004 |
| ADM-01.3 | N | HU-NUC-010 |
| ADM-01.4 | N | HU-ADM-005 |
| ADM-01.5 | N | HU-PRO-004 |
| ADM-01.6 | N | HU-ADM-003 |
| ADM-01.7 | S | HU-ADM-002 |
| SUP-01.1 | N | HU-SUP-001 |
| SUP-01.2 | N | HU-SUP-002 |
| SUP-01.3 | S | HU-SUP-002 |
| SUP-01.4 | N | HU-SUP-003 |
| LGP-01.1 | S | HU-LGP-001 |
| LGP-01.2 | S | HU-LGP-005 |
| LGP-01.3 | N | HU-LGP-002 |
| LGP-01.4 | N | HU-LGP-003 |
| LGP-02.1 | S | HU-LGP-008 |
| LGP-02.2 | S | HU-LGP-009 |
| LGP-02.3 | S | HU-LGP-010 |
| LGP-03.1 | N | HU-LGP-004 |
| LGP-03.2 | S | HU-LGP-007, HU-IA-013 |
| LGP-03.3 | S | HU-LGP-006 |
| LGP-03.4 | S | HU-LGP-011 |
| LGP-03.5 | N | HU-LGP-004 |
| LGP-03.8 | S | HU-LGP-012 |
