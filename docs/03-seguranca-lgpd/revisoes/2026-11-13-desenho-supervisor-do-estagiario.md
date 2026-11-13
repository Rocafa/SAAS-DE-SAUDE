# Revisão de desenho: supervisor do estagiário (PR #193, último item de backend da #167)

**Veredito: VETADO como está.** O desenho parte de uma leitura errada da norma: o dispositivo é o **art. 1º §2º** da
Res. COFFITO 414/2012 (não o art. 2º §1º, que não existe), e ele pede **identificação E assinatura** do supervisor e do
estagiário. Só identificar não basta: o supervisor precisa assinar (cofinalizar). Isso puxa dois furos que o desenho não
trata: o supervisor não tem vínculo de cuidado para ler o que vai assinar, e o sigilo da psicologia o barra. Com V1 a V4
resolvidos no texto, o desenho volta para nova revisão (curta) antes do código.

Revisor: guardiao-lgpd · Data: 13/11/2026 · Objeto: `docs/04-arquitetura/supervisor-do-estagiario.md` (branch
`eng/modelos-por-especialidade`) · Código lido: `apps/api/src/db/schema.ts` (`professionals` l.80, `encounters` l.330),
`apps/api/src/modules/records/prontuario.service.ts`, `prontuario-regras.ts` (`podeVerConteudo` l.18,
`hashDaFinalizacao` l.46), `apps/api/src/modules/auth/perfis.ts`, `apps/api/src/modules/auth/vinculo-de-cuidado.ts`.

## Fonte conferida

**FATO** (conferido em 13/11/2026 em <https://www.coffito.gov.br/nsite/?p=3177>, página oficial do COFFITO, HTTP 200):

- **Art. 1º §2º:** quando o atendimento ocorre em estágio (obrigatório ou não), o registro traz a **identificação e a
  assinatura** do responsável técnico/supervisor/preceptor, **que responde pelo serviço**, e do estagiário. O inciso I
  diz que o supervisor exige do estagiário o registro de todas as atividades e intercorrências.
- **Art. 1º §1º VIII:** identificação do profissional com nome completo e **número do CREFITO**, e data de cada
  procedimento. **Art. 2º, parágrafo único:** no prontuário eletrônico, nome completo e CREFITO logo após cada registro.
- **Art. 2º só tem parágrafo único.** A citação "art. 2º §1º" da #167 e do desenho está errada; corrigir nos dois.
- **Art. 6º I:** guarda mínima de 5 anos do último registro, ampliável por lei (a Lei 13.787/2018 amplia para 20).
- Data: a página traz a reunião de 19/01/2012 e publicação no DOU de 23/05/2012.

**NÃO CONFERIDO:** Res. COFFITO 415/2012 (TO) e a norma do CFP sobre registro de estagiário (Res. CFP 001/2009 e a de
estágio/supervisão). Não afirmo o que dizem. Conferir na fonte oficial antes de estender a regra a TO e psicologia.

## Respostas às quatro perguntas

**1. Cofinalização: sim, obrigatória para fisio.** O texto pede assinatura do supervisor, que "responde pelo serviço".
Desenho mínimo aceitável:
- o estagiário finaliza → status novo `aguardando_supervisor` (conteúdo congelado, como hoje na finalização);
- o supervisor **cofinaliza** com MFA recente (mesmo nível da finalização), gravando `cosigned_at`, `cosigned_by` e um
  segundo hash que encadeia o hash do estagiário + id do supervisor + horário (`hashDaCofinalizacao`, `v1` próprio);
  não reescrever `hashDaFinalizacao` (quebraria a verificação dos registros existentes);
- o supervisor **não edita** o texto do estagiário: discordância vira adendo dele (append-only, já existe);
- o supervisor pode **devolver** (não cofinalizar) com motivo auditado; o registro segue `aguardando_supervisor`;
- documento, tela e exportação só mostram o registro como "finalizado" depois da cofinalização; antes, marcam
  "pendente de assinatura do supervisor";
- pendência envelhecida (ex.: 7 dias) gera aviso ao supervisor e ao admin, sem conteúdo clínico no aviso.

**2. Congelar na abertura: certo, com um ajuste.** Congelar o supervisor **designado** na abertura está correto (mesma
lógica do B1 do #63). Mas quem **cofinaliza** fica gravado à parte (`cosigned_by`), e precisa ser o supervisor
congelado. Se ele ficar inativo com registro pendente, o admin redesigna **aquele atendimento** para outro supervisor
elegível, em operação auditada (`encounter_supervisor_reassigned`, com o anterior e o novo), sem apagar o congelado
original (guardar ambos ou o histórico). Nunca cofinalização automática nem pelo admin.

**3. Psicologia: não estender agora.** A norma do CFP não foi conferida; até lá, a regra vale para fisio (COFFITO 414)
e para TO **só depois** de conferir a 415. Enquanto isso, **bloquear** `estagiario = true` em profissional de área
sensível/psicologia (409 `estagiario_nao_suportado`), em vez de deixar o estagiário de psicologia registrar como
profissional pleno sem regra. Quando entrar: o supervisor precisa ler o compartimento `restrito_ao_autor`, então
`podeVerConteudo` ganha a exceção explícita "supervisor congelado deste atendimento", auditada com base própria, e o
paciente é informado de que o atendimento é de estagiário supervisionado (transparência, LGPD art. 6º VI e art. 9º).

**4. Antes do piloto: depende só da clínica do piloto, mas a lacuna não pode ficar silenciosa.**
- Se a clínica do piloto tem estagiário atendendo: entra antes do piloto (é requisito do conselho do profissional,
  não opcional).
- Se não tem: aceitável ir sem, com (a) declaração no termo/onboarding de que não há estagiário registrando, (b) item
  no checklist de prontidão, e (c) implementar antes da segunda clínica. Hoje um estagiário cadastrado como
  `profissional` produz registro que viola o art. 1º §2º sem ninguém perceber; é isso que (a) e (b) cobrem.

## Vetos (corrigir no desenho)

- **V1. Citação e escopo da norma.** Trocar "art. 2º §1º" por "art. 1º §2º" (desenho e #167) com URL e data acima, e
  trocar "basta identificar" por "identificação e assinatura" (cofinalização, pergunta 1).
- **V2. Vínculo de cuidado do supervisor.** O vínculo hoje deriva só da agenda do próprio profissional
  (`vinculo-de-cuidado.ts`); o supervisor não tem agendamento com o paciente do estagiário e levaria 403 ao tentar ler o
  que vai assinar. Criar a base `supervisao`, derivada **no servidor** de `encounters.supervisor_professional_id` =
  profissional da sessão, **restrita aos atendimentos do supervisionado** (não ao paciente inteiro), registrada em
  `care_basis` na trilha. Não pode virar porta para o prontuário completo do paciente.
- **V3. Registro no conselho não existe no cadastro.** O art. 1º §1º VIII e o art. 2º p.ú. exigem CREFITO, e o desenho
  promete "Supervisor: nome e registro", mas `professionals` não tem número de conselho (só o perfil fiscal PF tem).
  Adicionar `conselho` + `registro_conselho` no profissional (obrigatório para supervisor e para quem finaliza fisio/TO),
  e congelar o registro do supervisor no atendimento (ou no conteúdo do hash) para que mudança cadastral posterior não
  altere o que foi assinado. Para o estagiário: nome + "estagiário" + instituição de ensino; nada de matrícula, CPF ou
  dado acadêmico além disso (minimização, art. 6º III).
- **V4. Quem designa e quem consente.** "Só o admin" designa está certo (cadastro, `cadastros:gerir`), mas o admin não
  é perfil clínico e não pode criar responsabilidade técnica para alguém sem ciência: a designação fica **pendente até o
  supervisor aceitar** (ação dele, auditada `trainee_supervisor_accepted`). Sem aceite, o estagiário não abre
  atendimento (409 `supervisor_pendente`). Se o admin for também o profissional designado, o aceite continua sendo
  um passo separado, feito no perfil profissional e auditado. Desligar o vínculo de
  supervisão: admin ou o próprio supervisor, auditado; registros pendentes seguem a regra da pergunta 2.

## Correções (não bloqueiam a revisão do desenho, entram no código)

- **C1. Integridade no banco.** FK composta `(tenant_id, supervisor_professional_id)` → `professionals(tenant_id, id)`
  em `professionals` e em `encounters` (isolamento por tenant no banco, não só no trigger). Trigger também no sentido
  inverso: impedir inativar, marcar como estagiário ou trocar a profissão de quem supervisiona alguém ativo (ou exigir
  redesignação na mesma transação). Supervisor da **mesma profissão** do registro (fisio supervisiona fisio; COFFITO
  exige fisioterapeuta como RT).
- **C2. Hash.** O id **e o registro no conselho** do supervisor entram no conteúdo canônico do novo hash de
  cofinalização; o hash do estagiário também passa a incluir o `supervisor_professional_id` congelado (versão `v2` do
  canônico, com `v1` ainda verificável para os registros antigos).
- **C3. Trilha.** Ações novas: `trainee_supervisor_changed`, `trainee_supervisor_accepted`, `encounter_cosigned`,
  `encounter_cosign_returned`, `encounter_supervisor_reassigned`. Só ids, versões, hash e motivo codificado; nunca texto
  clínico nem o motivo livre da devolução na trilha (motivo livre, se houver, cifrado no registro).
- **C4. Exportação G2 e acesso do paciente.** A exportação total e a cópia do portal levam estagiário, supervisor
  (nome, conselho, registro), status de cofinalização e os dois hashes. O COFFITO 414 (art. 4º/5º, citado na #167) diz
  que o prontuário é do paciente: registro pendente de cofinalização também aparece na cópia, marcado como pendente.
- **C5. Retenção.** Supervisão, cofinalização e histórico de redesignação são parte do prontuário: 20 anos do último
  registro (Lei 13.787/2018 art. 6º §5º; `matriz-retencao.md`), append-only, `ON DELETE RESTRICT`; profissional que
  supervisionou nunca é apagado fisicamente, só inativado.
- **C6. Testes (TDD).** Estagiário sem supervisor (banco recusa); supervisor de outra clínica (FK recusa); supervisor
  estagiário, inativo ou de outra profissão (recusa); designação sem aceite (409); supervisor lê só atendimentos do
  supervisionado e não o resto do prontuário; cofinalização por outro profissional (403); estagiário de psicologia
  bloqueado; hash v1 antigo ainda verifica; redesignação preserva o supervisor congelado original.

## O que está bom

Congelar no atendimento, e não reescrever registros antigos; 409 quando o supervisor fica inativo; trocar supervisor
como operação auditada; contrato, horas e avaliação do estágio fora do escopo (minimização).
