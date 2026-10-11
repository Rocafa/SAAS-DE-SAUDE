# Golden sets do escriba (100% sintéticos)

> Frente IA-LLM · versão 1.0.0 · 10/10/2026. Protocolo de uso: [protocolo-avaliacao-escriba.md](../protocolo-avaliacao-escriba.md).

## O que é

Um **golden set** é um conjunto de consultas simuladas, cada uma com a nota que um bom profissional escreveria e com as armadilhas que o modelo não pode cair. Serve para medir o escriba antes de qualquer clínica usar e a cada troca de modelo ou de prompt.

| Arquivo | Nicho | Casos |
|---|---|---|
| [fisio-to.json](fisio-to.json) | Fisioterapia e terapia ocupacional | 8 |
| [psicologia.json](psicologia.json) | Psicologia | 8 |

**Esta é a semente, não o conjunto do gate.** O gate do M3 exige pelo menos 50 casos por nicho (protocolo §5). Os 16 casos cobrem cada tipo de caso difícil uma vez, para o formato e as checagens nascerem testados.

## Regras de origem (inegociáveis)

1. **Todo caso é inventado** pela frente IA-LLM. Não pode ser "inspirado" em atendimento real, nem com nomes trocados.
2. Nenhum nome, CPF, CNS, telefone, e-mail, endereço ou data de calendário. Pessoas são "paciente", "profissional" e "acompanhante".
3. Casos novos vindos de produção (Fase 2) **não entram aqui**. Eles vão para um conjunto anonimizado separado, com aprovação do Guardião LGPD e base legal registrada (`dados-e-treino.md`).
4. Revisão clínica: cada caso precisa do aceite de um profissional do nicho antes de contar para o gate (campo a acrescentar na v1.1: `revisado_por_nicho`).

O teste `apps/api/src/modules/ai/eval/golden-sets.test.ts` barra no CI arquivo sem `"sintetico": true` e qualquer padrão de CPF, CNS, telefone, e-mail ou data.

## Formato de um caso

| Campo | O que é |
|---|---|
| `id` | `FT-nnn` (fisio/TO) ou `PS-nnn` (psicologia) |
| `cenario`, `tags` | Descrição e tipo de dificuldade (`negacao`, `lateralidade`, `terceiro_citado`, `injecao_falada`, `risco`, `recusa_cfm_2454`...) |
| `consentimento_ia` | `nao_recusou` ou `recusou` |
| `resultado_esperado` | `rascunho` ou `bloqueado` (recusa do paciente: o escriba nem é chamado) |
| `transcricao` | Falas com `falante` (`PROFISSIONAL`, `PACIENTE`, `ACOMPANHANTE`) e `texto` |
| `nota_referencia` | `secoes[].itens[]` com `texto` e `ancora` (trecho **literal** da transcrição que sustenta o item), mais `alertas[]` |
| `obrigatorios` | Itens clínicos que a nota precisa conter (mede **omissão**) |
| `armadilhas` | Termos que **não podem** aparecer na nota (mede **alucinação clínica crítica**), com a `categoria` do erro |
| `alerta_obrigatorio` | `true` quando há risco (ideação suicida, violência, sinal de alerta neurológico) |

O modelo avaliado precisa devolver a nota **no mesmo formato** (JSON com âncoras). A âncora é o que torna a alucinação mensurável sem LLM: afirmação sem trecho correspondente na transcrição é suspeita por definição.

## Cobertura atual

| Dificuldade | Fisio/TO | Psicologia |
|---|---|---|
| Número ou dose por extenso | FT-001, FT-008 | n/a |
| Negação | FT-001 | PS-003 |
| Lateralidade e medida | FT-002 | n/a |
| Dado de terceiro (não entra na nota) | FT-003 | PS-004 |
| Instrução falada ao assistente (injeção) | FT-004 | PS-005 |
| Acompanhante ou responsável (quem disse o quê) | FT-005 | PS-006 |
| Risco que exige alerta | FT-006 | PS-002, PS-008 |
| Recusa do paciente (CFM 2.454/2026) | FT-007 | PS-007 |
| Diagnóstico ou medicação não ditos | FT-005 | PS-001, PS-006 |

**Faltam para a v2 (gate):** áudio ruidoso e conversas paralelas (dependem do STT), sotaques regionais, teleatendimento, sessões longas (> 45 min), avaliação inicial completa e casos de TEA/ABA (onda 2).
