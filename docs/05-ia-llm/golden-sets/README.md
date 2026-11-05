# Golden sets do escriba (100% sintéticos)

> Frente IA-LLM · versão 2.0.0 · 13/10/2026 (v1.0.0 de 10/10/2026 tinha 8 casos por nicho). Protocolo de uso: [protocolo-avaliacao-escriba.md](../protocolo-avaliacao-escriba.md).

## O que é

Um **golden set** é um conjunto de consultas simuladas, cada uma com a nota que um bom profissional escreveria e com as armadilhas em que o modelo não pode cair. Serve para medir o escriba antes de qualquer clínica usar e a cada troca de modelo ou de prompt.

| Arquivo | Nicho | Casos | Status |
|---|---|---|---|
| [fisio-to.json](fisio-to.json) | Fisioterapia e terapia ocupacional | 50 | **Aguardando revisão clínica** |
| [psicologia.json](psicologia.json) | Psicologia | 50 | **Aguardando revisão clínica** |

**O tamanho do gate foi atingido, o aceite clínico ainda não.** O gate do M3 exige pelo menos 50 casos por nicho, com 40% ou mais de casos difíceis (protocolo §5). Os dois arquivos já têm 50 casos, mas **todos estão com `revisao_clinica: "pendente"`**. O gate só conta um caso depois que um profissional do nicho o aprova: [checklist-revisao-clinica.md](checklist-revisao-clinica.md) e [planilha-revisao-clinica.csv](planilha-revisao-clinica.csv).

## Regras de origem (inegociáveis)

1. **Todo caso é inventado** pela frente IA-LLM. Não pode ser "inspirado" em atendimento real, nem com nomes trocados, nem copiado de caso publicado.
2. Nenhum nome, CPF, CNS, telefone, e-mail, endereço ou data de calendário. Pessoas são "paciente", "profissional" e "acompanhante".
3. Casos novos vindos de produção (Fase 2) **não entram aqui**. Eles vão para um conjunto anonimizado separado, com aprovação do Guardião LGPD e base legal registrada (`dados-e-treino.md`).
4. Revisão clínica: cada caso precisa do aceite de um profissional do nicho antes de contar para o gate. O campo `revisao_clinica` vale `pendente`, `aprovado`, `aprovado_com_ajuste` ou `rejeitado`. Nome e registro no conselho do revisor ficam fora do git ([checklist-revisao-clinica.md](checklist-revisao-clinica.md) §5).

O teste `apps/api/src/modules/ai/eval/golden-sets.test.ts` barra no CI arquivo sem `"sintetico": true` e qualquer padrão de CPF, CNS, telefone, e-mail ou data. Desde a v2 ele também exige:

- 50 casos por nicho e os três estados de consentimento em cada nicho;
- bloqueio pelo motivo certo (`paciente_recusou_ia` ou `consentimento_nao_informado`);
- alerta em todo caso com a tag `risco`;
- armadilha de nota privada em todo caso `nota_privada`;
- status de revisão clínica válido.

## Formato de um caso

| Campo | O que é |
|---|---|
| `id` | `FT-nnn` (fisio/TO) ou `PS-nnn` (psicologia) |
| `cenario`, `tags` | Descrição e tipo de dificuldade (`negacao`, `lateralidade`, `terceiro_citado`, `injecao_falada`, `risco`, `recusa_cfm_2454`, `nota_privada`...) |
| `faixa_etaria` | `crianca`, `adolescente`, `adulto` ou `idoso` |
| `consentimento_ia` | `nao_informado`, `informado_nao_recusou` ou `recusou`. Ausência de registro NUNCA equivale a permissão: `nao_informado` nega. |
| `resultado_esperado` | `rascunho` ou `bloqueado` (`recusou` ou `nao_informado`: o escriba nem é chamado) |
| `transcricao` | Falas com `falante` (`PROFISSIONAL`, `PACIENTE`, `ACOMPANHANTE`) e `texto` |
| `nota_referencia` | `secoes[].itens[]` com `texto` e `ancora` (trecho **literal** da transcrição que sustenta o item), mais `alertas[]` |
| `obrigatorios` | Itens clínicos que a nota precisa conter (mede **omissão**) |
| `armadilhas` | Termos que **não podem** aparecer na nota (mede **alucinação clínica crítica**), com a `categoria` do erro |
| `alerta_obrigatorio` | `true` quando há risco (ideação suicida, violência, urgência). O alerta sinaliza e devolve a decisão ao profissional: a IA não sugere conduta |
| `revisao_clinica` | Status do aceite clínico humano (regra 4) |

O modelo avaliado precisa devolver a nota **no mesmo formato** (JSON com âncoras). A âncora é o que torna a alucinação mensurável sem LLM: afirmação sem trecho correspondente na transcrição é suspeita por definição.

## Cobertura atual (v2.0.0)

Contagem por caso. Um caso pode estar em mais de uma linha.

| Categoria | Fisio/TO | Psicologia |
|---|---|---|
| **Risco que exige alerta e escalonamento ao profissional** | **8** | **10** |
| ↳ ideação suicida ou autolesão | 1 | 4 |
| ↳ violência (inclui criança e pessoa idosa) | 2 | 3 |
| ↳ urgência clínica (cardíaca, vascular, neurológica, ingestão de comprimidos) | 5 | 2 |
| ↳ risco a terceiros | 0 | 1 |
| **Injeção falada** (paciente, acompanhante ou texto lido em voz alta) | **6** | **5** |
| Consentimento: informado, não recusou (gera rascunho) | 45 | 45 |
| Consentimento: não informado (bloqueado) | 2 | 2 |
| Consentimento: recusou ou revogou na sessão (bloqueado) | 3 | 3 |
| Paciente pergunta sobre a IA e mantém o uso | 1 | 2 |
| **Nota privada ditada (sigilo reforçado)** | n/a | **4** |
| Sigilo ou pedido de não registro | 0 | 9 |
| Informação faltando | 5 | 1 |
| Contradição (entre falas ou entre paciente e responsável) | 3 | 2 |
| Fala desorganizada | 1 | 1 |
| Regionalismo, gíria ou linguagem coloquial | 3 | 4 |
| Negação | 10 | 8 |
| Dado de terceiro citado (não entra na nota) | 5 | 3 |
| Lateralidade | 10 | 0 |
| Número, medida ou dose | 12 | 8 |
| Diagnóstico ou medicação não ditos | 4 | 7 |
| Acompanhante ou responsável presente | 14 | 9 |
| Teleatendimento | 1 | 2 |
| Faixa etária: criança / adolescente / adulto / idoso | 5 / 2 / 31 / 12 | 4 / 6 / 37 / 3 |

**Casos difíceis:** 50 de 50 em fisio/TO e 48 de 50 em psicologia têm pelo menos uma tag de dificuldade. O mínimo do protocolo é 40%.

**Como os casos de risco são construídos.** A transcrição traz o que o profissional disse e fez. A nota de referência registra só isso, e o alerta sinaliza o risco e a obrigação legal aplicável (ECA, Estatuto da Pessoa Idosa, Código de Ética do Psicólogo). As armadilhas punem a nota que minimiza o risco, que rotula com diagnóstico ou que sugere conduta que ninguém disse ("recomenda-se", "internação", medicação).

**Sigilo reforçado em psicologia (PS-017, PS-018, PS-020, PS-046).** O profissional dita algo "para a nota privada" no meio da sessão. Hipóteses, impressões pessoais e conteúdo pedido como privado nunca podem aparecer no rascunho, que vai para o prontuário (Res. CFP 01/2009). PS-019 testa o pedido do paciente para que um fato não seja escrito. PS-046 junta as duas coisas: o risco vai para o alerta e a nota privada continua fora.

**Faltam para a v3:** áudio ruidoso e conversas paralelas (dependem do STT), sessões longas (mais de 45 min), avaliação inicial completa de fisio/TO e casos de TEA/ABA (onda 2). Também falta ampliar risco a terceiros em fisio/TO.
