# Registro feito por estagiário: identificação e assinatura do supervisor (desenho v2)

> 13/11/2026 · Maestro · **desenho v2, sem código**, refeito sobre o veto do Guardião (`revisoes/2026-11-13-desenho-supervisor-do-estagiario.md`). A v1 está no histórico do git.
> **Base, conferida em https://www.coffito.gov.br/nsite/?p=3177 em 13/11/2026:** Res. COFFITO 414/2012, **art. 1º §2º**. Em estágio, obrigatório ou não, o registro traz a **identificação e a assinatura** do responsável técnico, supervisor ou preceptor, que **responde pelo serviço**, e do estagiário. **Art. 1º §1º VIII:** nome completo e número do CREFITO de quem registra. O "art. 2º §1º" citado na #167 não existe.
> **TO:** a Res. COFFITO 415/2012 tem a mesma regra no **art. 1º §2º** (conferida em https://www.coffito.gov.br/nsite/?p=3178 em 13/11/2026), então o desenho vale para **fisioterapia e TO**. **Não conferido:** as normas do CFP sobre estágio. A psicologia fica fora até conferir.

## Decisão que vem antes do código (sócios)

**A clínica do piloto tem estagiário atendendo?**
- **Sim:** isto entra antes do piloto, porque é requisito do conselho do profissional.
- **Não:** o piloto pode ir sem, desde que haja:
  - uma declaração no termo de adesão de que nenhum estagiário registra no sistema;
  - um item no checklist de prontidão;
  - a implementação antes da segunda clínica.

## Desenho

**1. Cadastro do profissional**
- Novos campos: `conselho` e `registro_conselho`. São obrigatórios para quem finaliza registro de fisioterapia e para todo supervisor (V3).
- `estagiario`, com a instituição de ensino. Nada de matrícula, CPF ou dado acadêmico (minimização).
- `supervisor_professional_id`, com FK composta `(tenant_id, id)` (C1). O supervisor precisa ser:
  - da mesma profissão do estagiário (fisioterapeuta ou terapeuta ocupacional);
  - ativo e não estagiário;
  - com registro no conselho.
- Um trigger impede inativar, marcar como estagiário ou trocar a profissão de quem supervisiona alguém, sem redesignar na mesma transação.
- Estagiário de psicologia ou área sensível: recusado com 409 `estagiario_nao_suportado`.

**2. Designação com aceite (V4)**
- O admin designa o supervisor (`cadastros:gerir`), e a designação fica **pendente até o supervisor aceitar**, no perfil profissional dele (`trainee_supervisor_accepted`).
- Sem aceite, o estagiário não abre atendimento (409 `supervisor_pendente`).
- Desligar a supervisão: o admin ou o próprio supervisor, com registro na trilha.

**3. Atendimento**
- Na abertura, ficam congelados no atendimento o supervisor designado e o registro dele no conselho (C2).
- O hash da finalização do estagiário passa à versão v2 do canônico, que inclui o supervisor congelado. A v1 continua verificável.

**4. Cofinalização (pergunta 1)**
- O estagiário finaliza e o registro fica `aguardando_supervisor`, com o conteúdo congelado.
- O supervisor **cofinaliza** com MFA recente. Ficam gravados `cosigned_at`, `cosigned_by` e um **segundo hash** que encadeia o hash do estagiário, o id e o registro do supervisor e a hora (`hashDaCofinalizacao`, v1 própria). O hash atual não é reescrito.
- O supervisor **não edita** o texto do estagiário. Se discordar, escreve um adendo. Também pode **devolver** com motivo codificado; o texto livre, se houver, fica cifrado e fora da trilha.
- Tela, documento e exportação só mostram "finalizado" depois da cofinalização. Antes disso, mostram "pendente de assinatura do supervisor".
- Pendência com mais de 7 dias gera aviso ao supervisor e ao admin, sem conteúdo clínico.
- Supervisor inativo com registro pendente: o admin redesigna **aquele atendimento**, com trilha (`encounter_supervisor_reassigned`). O congelado original é guardado. Nunca há cofinalização automática nem pelo admin.

**5. Vínculo "supervisão" (V2)**
- O supervisor não tem agendamento com o paciente. A base nova `supervisao` é derivada **no servidor** de `encounters.supervisor_professional_id = profissional da sessão`.
- Ela vale **só para os atendimentos do supervisionado**, nunca para o prontuário inteiro do paciente, e é gravada em `care_basis` na trilha.

**6. Trilha (C3)**
Ações novas: `trainee_supervisor_changed`, `trainee_supervisor_accepted`, `encounter_cosigned`, `encounter_cosign_returned` e `encounter_supervisor_reassigned`. Levam só ids, versões, hash e motivo codificado.

**7. Exportação, portal e retenção (C4, C5)**
- A exportação total e a cópia do portal levam:
  - o estagiário e o supervisor (nome, conselho e registro);
  - o status da cofinalização;
  - os dois hashes.
- O registro pendente também aparece, marcado como pendente: o prontuário é do paciente (COFFITO 414, art. 4º e 5º).
- A retenção é a do prontuário (20 anos), em append-only. Quem supervisionou nunca é apagado fisicamente.

**8. Testes (C6)**
Todos os da lista do parecer, escritos antes do código.

## Tamanho

Grande: migração, cadastro, abertura, cofinalização, vínculo novo, exportação, portal e telas (do front). Divido em três PRs:
1. cadastro, conselho e aceite;
2. congelamento, cofinalização e vínculo de supervisão;
3. exportação, portal e aviso de pendência.
