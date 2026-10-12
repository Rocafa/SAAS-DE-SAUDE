# Revisão LGPD & Segurança: Garantias ao cliente (branch `produto/garantias-ao-cliente`)

> Revisor: agente `guardiao-lgpd` (N1, veto) · Data: 2026-10-09 · Base: [papeis-controlador-operador.md](../papeis-controlador-operador.md) (DPA cl. 12), [requisitos-tecnicos-seguranca.md](../requisitos-tecnicos-seguranca.md), [checklist-pr.md](../checklist-pr.md), WBS EXP-01.1/01.5/01.6, NUC-02.3.
> Escopo: `docs/02-produto/garantias-ao-cliente.md` (52 linhas) e o trecho novo de `docs/02-produto/definicao-de-pronto.md` (linhas 112-118). Só documentação. Não é parecer jurídico; itens ⚖️ vão ao advogado (D8).

## Veredito: **VETADO** (2 bloqueantes, correção textual simples)

Libera para merge assim que B1 e B2 forem corrigidos. Os 🟡 precisam estar fechados **antes de qualquer publicação** da Carta (site/contrato) e antes do merge de `eng/garantia-de-saida`. Os 🟢 são sugestões.

Pontos fortes: regra "garantia sem mecanismo não vai para o marketing" (l.12); exigência de revisão jurídica antes de publicar (l.14); exportação com isolamento por tenant e auditoria append-only (l.21); papel da clínica como controladora reconhecido (l.32, "seus dados são da sua clínica"); DoD amarrando G1–G3 a testes no CI. Nenhum dado pessoal, segredo ou certificado no diff.

## 🔴 Bloqueantes

**B1. G1 promete acesso e exportação "nunca" bloqueados após cancelamento, o que contradiz G3 e a DPA (l.20).**
"Atraso ou cancelamento nunca bloqueia a consulta nem a exportação" é uma promessa perpétua. G3 (l.22) e a DPA cl. 12 dizem que, 90 dias após o cancelamento, os dados são eliminados. Publicado assim, o texto é publicidade enganosa (CDC art. 37 §1º) e vira obrigação contratual impossível de cumprir. Além disso, "`canRead`/`canExport` sempre verdadeiros" pode ser lido pela engenharia como "ignora RBAC/MFA". Essa especificação seria perigosa, porque EXP-01.5 restringe a exportação total a admin com MFA.
Correção proposta (l.20, colunas 3 e 4):
> **Atraso de pagamento nunca bloqueia a consulta nem a exportação dos seus dados**; inadimplência só pausa o cadastro de novos registros. Após o cancelamento, consulta e exportação seguem liberadas pelo prazo da G3.
> **Código + teste no CI:** a política por status de assinatura **não restringe** `read`/`export` em nenhum status (ativo, inadimplente, suspenso, cancelado dentro do prazo da G3); RBAC, MFA, RLS e os controles de EXP-01.5 continuam valendo. O teste cobre todos os status.

**B2. G3 e a Carta são ambíguas sobre quem guarda o prontuário por 20 anos (l.22 e l.34).**
"Eliminação com certificado, preservando o que a lei manda guardar sob sua responsabilidade (prontuário: 20 anos)" dá a entender que **nós** preservamos o prontuário. A DPA cl. 12 diz o contrário: eliminamos tudo, exceto se a clínica contratar a custódia, e a clínica continua responsável pela guarda legal. Já a Carta (l.34) só diz "ficam disponíveis por 90 dias". Uma clínica que não exportar perde o prontuário que é obrigada a guardar (Lei 13.787/2018 art. 6º; CFM Res. 1.821/2007; Código de Ética Médica arts. 85-87). O dano recai sobre o paciente e gera discussão de responsabilidade (LGPD art. 42; CDC art. 14). É exatamente o risco que a matriz pretende eliminar.
Correção proposta (l.22, coluna 3):
> **Depois do cancelamento, seus dados ficam disponíveis em modo leitura por no mínimo 90 dias**, com a exportação completa liberada. Avisamos os administradores com 30, 7 e 1 dia de antecedência. Ao fim do prazo, eliminamos os dados com certificado, **salvo se a clínica contratar a custódia de guarda legal**. A guarda do prontuário pelo prazo legal (20 anos para prontuário médico, Lei 13.787/2018) é responsabilidade da clínica, e por isso a exportação vem antes da eliminação.

Coluna 4: acrescentar "**Processo:** e-mails de aviso D-30/D-7/D-1 testados; a eliminação exige registro de que a exportação foi oferecida."
Carta (l.34):
> Quer sair? Cancele pelo próprio sistema, sem ligação e sem multa. Seus dados ficam disponíveis por 90 dias para exportação completa e gratuita. **Lembre-se: a guarda legal do prontuário é da sua clínica**; se preferir, guardamos para você com o serviço de custódia.

## 🟡 Ressalvas (antes de publicar)

**M1. Exportação total (G2, l.21): os controles anti-exfiltração existem em EXP-01.5, mas não aparecem na garantia nem na DoD.**
EXP-01.5 cobre MFA para o admin, link que expira em 24 h, arquivo criptografado, auditoria e alerta a todos os admins. Na G2, porém, ele aparece só como código de WBS, e "a qualquer momento" soa incondicional. Também faltam controles contra conta comprometida:
(a) **re-autenticação recente** (MFA nos últimos 5 min) no momento do pedido, não só na sessão;
(b) link **vinculado ao usuário autenticado** (não *bearer*), com limite de downloads;
(c) alerta **fora de banda** (e-mail de todos os admins e do RT) com botão "não fui eu", que revoga o link e encerra as sessões;
(d) **janela de segurança** opcional (ex.: arquivo liberado 1 h após o alerta) para a exportação total;
(e) bloqueio temporário quando houver suspeita de comprometimento, previsto no contrato.
Correção (l.21, coluna 3): acrescentar
> Protegida contra uso indevido (EXP-01.5): só admin com MFA recente, link pessoal que expira em 24 h, arquivo criptografado, alerta imediato a todos os administradores e possibilidade de cancelar a exportação. Em caso de suspeita de invasão da conta, a exportação pode ser pausada até a verificação.

Atualizar EXP-01.5 e HU-EXP-001 com os itens (a) a (e). Na DoD (l.117), acrescentar:
> `- [ ] Mantém verdes os testes de EXP-01.5 (MFA recente, expiração do link, alerta a admins, auditoria da exportação).`

**M2. Sigilo profissional na exportação total (l.21; CFM CEM art. 85; CFP Res. 01/2009 e 06/2019; CFO CEO art. 14).** O "admin" pode não ser profissional de saúde, e a exportação total entrega todo o conteúdo clínico, inclusive registros de psicologia, a quem não tem dever de sigilo. Correção: a exportação total exige papel admin **e** ciência ou aprovação do responsável técnico (RT); o manifesto identifica as seções com restrição profissional; o termo de exportação lembra o dever de sigilo. ⚖️

**M3. Prazos de guarda por conselho e obrigações próprias na eliminação (l.22).** "Prontuário: 20 anos" vale para o prontuário médico (Lei 13.787/2018). A CFP Res. 01/2009 fixa no mínimo 5 anos, e o CFO tem regra própria. A regra geral de exceção (vale para o maior prazo aplicável) deve ser citada por categoria. Além disso, a eliminação precisa ressalvar o que **nós** guardamos como controlador por obrigação legal (LGPD art. 16, I): registros de acesso por 6 meses (Marco Civil art. 15), documentos fiscais e de cobrança (5 anos, CTN arts. 173-174) e trilha de auditoria da própria eliminação. Precisa também declarar o prazo de expurgo dos **backups** (ex.: até 35 dias por rotação). Correção: acrescentar à G3 "exceto registros que a lei obriga a plataforma a manter (acesso, fiscal, auditoria), pelo prazo legal; backups expiram por rotação em até N dias, informado no certificado". ⚖️

**M4. G7 promete "até 15 min" de forma absoluta, mas o mecanismo mede o p90 (l.26 e l.37).** Até 10% dos casos podem passar do prazo sem acionar o alarme, o que é enganoso pelo CDC art. 37 §1º. Correção:
> Meta: **90% das primeiras respostas em até 15 min** em horário comercial (dias úteis, 8h-18h), com o resultado do mês publicado.

**M5. "Assinatura digital incluída" (l.24 e l.35) pode induzir a erro (CDC arts. 31 e 37).** O certificado ICP-Brasil (e-CPF A1/A3/nuvem) do profissional é normalmente pago à parte à AC, e a prescrição e o prontuário eletrônico exigem ICP-Brasil (CFM Res. 1.821/2007 NGS2, Res. 2.299/2021). "Cota justa" de IA também é vaga. Correção:
> Assinatura digital incluída (você usa seu certificado ICP-Brasil; o certificado é emitido por uma AC e não está incluído, salvo indicação na página de preço). IA incluída até X [unidade]/mês por profissional; o excedente é avisado antes de ser cobrado.

**M6. Atribuição indevida ao Guardião (l.39).** "Observação do Guardião LGPD já incorporada" apresenta o texto como aprovado, mas ele ainda não foi aprovado. Correção:
> Revisão LGPD: [revisoes/2026-10-09-garantias.md](../03-seguranca-lgpd/revisoes/2026-10-09-garantias.md). Publicação condicionada às correções dela e à validação jurídica (D8).

## 🟢 Sugestões

- S1 (l.10): os números do Reclame Aqui (6,4; 18%) precisam de URL e data inline (AGENTS.md regra 6). Não usar nomes de concorrentes na Carta pública (publicidade comparativa, CONAR).
- S2 (G7): orientar no chat de suporte que não se envie dado de paciente; o acesso do suporte ao tenant segue o fluxo de acesso emergencial (*break-glass*) auditado, com autorização da clínica.
- S3 (G8): no rollback, apagar também os arquivos de origem e o staging da migração, com prazo definido.
- S4 (G9): a status page não pode expor nome de clínica nem identificadores de tenant.
- S5 (§3 item 4): a métrica "tempo até a exportação pronta" deve ser agregada, sem identificar a clínica no painel público.
- S6 (l.32): "guardá-los bem" está adequado. Evitar acrescentar "100% seguro" ou "nunca vaza" em versões futuras, pois seriam garantias absolutas.

## Resumo do checklist aplicável

| Item | Resultado |
|---|---|
| Base legal / papéis | Clínica controladora e plataforma operadora, coerente com a l.32. A eliminação deve ressalvar o que guardamos como controlador (M3). |
| Retenção do prontuário | 🔴 B2: ambiguidade sobre quem guarda. |
| Eliminação após 90 dias | Coerente com a DPA cl. 12 depois do B1/B2; faltam os avisos prévios e o expurgo de backup (B2, M3). |
| Auditoria da exportação | Coberta (append-only, l.21; EXP-01.5). |
| Controle de acesso / exfiltração | Parcial: EXP-01.5 cobre o essencial; faltam a re-autenticação, o link vinculado e o "não fui eu" (M1). |
| Isolamento por tenant | Coberto (teste de isolamento na exportação, l.21). |
| CDC art. 37 / garantias absolutas | 🔴 B1; 🟡 M4, M5. |
| Marco Civil | Guarda de registros de acesso por 6 meses deve ser ressalvada na eliminação (M3). |
| Dados reais / segredos no diff | Nenhum. |

## Acompanhamento das ressalvas (10/10/2026, branch `lgpd/ripd-dpa-retencao`)

B1 e B2 foram corrigidos antes do merge do PR #8. Situação das ressalvas M1–M6 depois desta rodada:

| Ressalva | Situação | Onde |
|---|---|---|
| M1 | ✅ G2 com os controles (a)–(e), incluindo link não-portador com limite de downloads; EXP-01.5 (WBS) com critérios (a)–(e); DoD atualizada | `garantias-ao-cliente.md` G2, `WBS-micropartes.md` EXP-01.5, `definicao-de-pronto.md` |
| M2 | ✅ Exportação total exige admin **e** aprovação registrada do RT; manifesto marca seções com sigilo profissional; termo lembra o sigilo. ⚖️ | G2, EXP-01.5 |
| M3 | ✅ Prazos por conselho na G3; ressalva do que guardamos como controladora (acesso 6 meses, fiscal 5 anos, auditoria da eliminação); prazo de expurgo de backup informado no certificado | G3, [retencao-e-descarte.md](../retencao-e-descarte.md) ⚖️ |
| M4 | ✅ Já aplicada: "90% das primeiras respostas em até 15 min em horário comercial" | G7 e Carta |
| M5 | ✅ Certificado ICP-Brasil fora do preço (emitido por AC), cota de IA na página de preço, excedente avisado antes; marcação Markdown corrigida | G5 e Carta |
| M6 | ✅ Nota final reescrita: publicação condicionada às correções e à D8 | `garantias-ao-cliente.md` §2 |

Este acompanhamento é do próprio Guardião; a aprovação final da Carta depende da validação jurídica (D8).
