# Análise das entrevistas: da planilha às decisões D1 e D2

> Use depois da última entrevista (dia 10 do [README](README.md)). Entrada: `planilha-respostas.csv`. Saída: a página de conclusão (§6), colada em [`decisoes.md`](../../00-governanca/decisoes.md) e salva como `docs/01-mercado/entrevistas/AAAA-MM-DD-conclusao.md`.
> Tudo o que sai desta análise é **[ESTIMATIVA qualitativa]** com n = 7 a 10. Escreva sempre "n de N" (ex.: "5 de 8"), nunca só a porcentagem.

## 1. Preencher e limpar a planilha
- Uma linha por entrevista; o ensaio não entra.
- Valores padronizados:
  - `cota`: A (fisio/TO), B (psicólogo autônomo), C (TEA).
  - Sim/não: `S` / `N` / `NS` (não sabe) / vazio (não perguntado).
  - Valores em reais sem "R$" e com ponto decimal (ex.: `129.90`).
  - Dores (`dor_1` a `dor_5`, da mais forte para a mais fraca), com estes códigos: `AGD` agenda e faltas · `PAC` pacotes e saldo · `GUI` guias de convênio · `REP` repasse · `COB` cobrança e inadimplência · `REC` recibos, Receita Saúde e NFS-e · `PRO` tempo de prontuário/evolução · `SIS` sistema atual (preço, suporte, contrato) · `MIG` medo ou trabalho de migrar · `TEA` prova de execução e glosa · `OUT` outra (explicar em `observacoes`).
  - `dor_confirmada_com_exemplo`: `S` só se a pessoa contou um caso do **último mês** com custo de tempo ou dinheiro.
  - `H1`–`H10`: `C` confirma · `R` refuta · `I` inconclusivo · `NA` não se aplica à cota.
- Conferir que nenhuma célula tem nome, clínica, bairro ou dado de paciente (consentimento.md §3).

## 2. Tabela de hipóteses
Regra de leitura: **confirmada** se o critério for atingido; **refutada** se o resultado ficar claramente abaixo (menos da metade do critério); **inconclusiva** no meio do caminho ou com n abaixo do mínimo. Os critérios vêm do [relatório executivo §6.2](../relatorio-executivo-mercado.md); os ajustes para o tamanho desta amostra estão na coluna "n mínimo".

| H | Hipótese (resumo) | Quem conta | Critério | n mínimo | Resultado (n de N) | Status |
|---|---|---|---|---|---|---|
| H1 | Fisio/TO pagam R$ 99–129/prof. com tudo incluído | Cota A | ≥ 50% aceitam R$ 129 (§3.2) | 4 | | |
| H2 | Guia + saldo sem TISS XML basta para migrar no MVP | Cota A mista | ≥ 60% `opera_sem_xml_6m` = S | 2 | | |
| H3 | TEA paga ≥ R$ 60/paciente e "prova de execução" é dor top 2 | Cota C | ≥ 4 de 6 | 6 | | **Inconclusiva por desenho** (só 1–2 TEA); registrar o sinal |
| H4 | Troca é motivada por contrato/suporte, mais que funcionalidade | A + B | ≥ 50% citam cancelamento, suporte ou extras | 6 | | |
| H5 | Migração é a principal barreira | A + B | ≥ 50% `migracao_principal_barreira` = S | 6 | | |
| H6 | Psicólogo adota sem demonstração a < R$ 100/mês | Cota B | Sinal: ≥ 50% aceitam R$ 99 (§3.2). Confirmação real só com landing page (conversão ≥ 15%) | 2 | | No máximo "sinal positivo" |
| H7 | Repasse em planilha ou à mão (clínicas de 3+) | A com 3+ prof. | ≥ 60% | 2 | | |
| H8 | Escriba aceito com revisão < 1 min | A + B | ≥ 60% `usaria_escriba` = S | 6 | | |
| H9 | TEA usa 2+ sistemas/planilhas | Cota C | ≥ 4 de 6 | 6 | | Inconclusiva por desenho |
| H10 | Pix/recorrência valem take rate | A + B | ≥ 40% `aceita_gateway` = S | 6 | | |
| D14 | Receita Saúde em lote é dor real | Pessoa física (B + autônomos A) | ≥ 50% gastam ≥ 30 min/mês com recibos [critério nosso] | 2 | | |

Também contar: **ranking de dores** (quantas vezes cada código aparece como `dor_1` e entre `dor_1`–`dor_3`), e **gasto atual** (mediana de `gasto_mensal_total_rs` por cota, dividido por `porte_profissionais` na cota A). O gasto atual é o melhor dado de preço que teremos, porque é comportamento.

## 3. Como calcular a faixa de preço (Van Westendorp simplificado)
Calcule separado por cota (A por profissional/mês; B por mês; C por paciente ativo/mês). Nunca misture cotas.

### 3.1 Curvas (para enxergar a faixa)
Monte uma grade de preços (A e B: R$ 40 a R$ 250, de 10 em 10; C: R$ 20 a R$ 150). Para cada preço P, calcule a parcela de respondentes da cota:

| Curva | Fórmula (Planilhas Google, intervalo da cota) |
|---|---|
| Barato demais | `=CONT.SE(vw_barato_demais; ">="&P) / CONT.NÚM(vw_barato_demais)` |
| Não é barato | `=1 - CONT.SE(vw_barato; ">="&P) / CONT.NÚM(vw_barato)` |
| Não é caro | `=1 - CONT.SE(vw_caro; "<="&P) / CONT.NÚM(vw_caro)` |
| Caro demais | `=CONT.SE(vw_caro_demais; "<="&P) / CONT.NÚM(vw_caro_demais)` |

- **Preço mínimo aceitável (PMC):** primeiro P em que "barato demais" ≤ "não é barato".
- **Preço máximo aceitável (PME):** primeiro P em que "caro demais" ≥ "não é caro".
- **Faixa aceitável = PMC a PME.** Com n de 4 a 5 as curvas andam em degraus de 20–25 pontos: trate os cruzamentos como aproximados e arredonde para a dezena.

### 3.2 Aceitação de um preço (é o número que decide)
Um respondente **aceita o preço P** se `vw_barato_demais < P < vw_caro_demais`.
- **H1:** conte quantos da cota A aceitam **R$ 129** e quantos aceitam **R$ 99**.
  - ≥ 50% aceitam R$ 129 → H1 confirmada para a faixa toda.
  - ≥ 50% aceitam R$ 99, mas < 50% aceitam R$ 129 → confirmada **só no piso**: preço de lista R$ 99.
  - < 50% aceitam R$ 99 → H1 refutada: usar a mediana de `vw_caro` da cota A como teto provisório e refazer a conta de margem do [memo D02](../../00-governanca/memos/D02-preco.md).
- **Psicólogo:** mesma conta para **R$ 99** e **R$ 79** na cota B.
- **TEA:** conte quantos aceitam **R$ 60/paciente** (só sinal, n ≤ 2).

### 3.3 Checagem de sanidade
Compare a faixa com o gasto atual (§2) e com os preços dos concorrentes: fisio R$ 0–180/profissional, ZenFisio a partir de R$ 79 [FATO, [zenfisio.com](https://www.zenfisio.com/), acesso 06/10/2026, via [nichos/fisioterapia-to.md](../nichos/fisioterapia-to.md) §6]; psicologia R$ 39–119 no núcleo, PsicoManager R$ 89–119 [FATO, [psicomanager.com.br/planos](https://www.psicomanager.com.br/planos), acesso 06/10/2026, via [nichos/psicologia-saude-mental.md](../nichos/psicologia-saude-mental.md) §6]. Se a faixa aceitável ficar muito acima do que a pessoa já paga, desconfie: é a opinião falando mais alto que o comportamento.

## 4. Como decidir a D1 (nicho)
Aplique as 4 condições do [README](README.md#quando-d1-e-d2-estão-decididos) em ordem:

| # | Condição | Fonte na planilha | Atingiu? |
|---|---|---|---|
| 1 | ≥ 75% da amostra principal (A + B) com `dor_confirmada_com_exemplo` = S em AGD, PAC, GUI, REP ou COB | `dor_1`–`dor_3`, `dor_confirmada_com_exemplo` | |
| 2 | H2 confirmada (≥ 60% das mistas) | `opera_sem_xml_6m` | |
| 3 | ≥ 50% pensaram em trocar em 12 meses ou usam planilha/papel | `pensou_trocar_12m`, `sistema_atual` | |
| 4 | ≥ 3 aceitam ser parceiras de design | `aceita_parceira_design` | |

- **4 de 4:** manter a opção A do memo.
- **3 de 4:** manter a opção A e registrar o risco da condição que falhou, com ação (ex.: 3 novas entrevistas só sobre ela).
- **2 ou menos:** reabrir a D1 antes do M1. Olhar onde a dor apareceu mais forte (ranking de dores por cota) para escolher entre as opções B e C do memo.
- **Desempate fisio × psicólogo:** se só uma cota passar, ela vira o foco da onda 1 e a outra vira canal secundário.
- **TEA:** se as clínicas C mostrarem H3 e H9 com sinal forte, anotar "antecipar validação da onda 2 (mais 4 entrevistas TEA)", sem mudar a D1.

## 5. Como decidir a D2 (preço)
1. Ler H1 e o resultado de psicólogo (§3.2) e escolher o preço de lista por cota.
2. Conferir a G5 ("tudo incluído"): se ≥ 50% pagam ou reclamam de extras (`paga_extras`, `motivo_troca`), a promessa de preço único tem valor e fica.
3. Conferir a margem: preço escolhido × profissionais contra o custo variável de IA (R$ 0,30–0,58/consulta) e WhatsApp (R$ 32–64/clínica com 400 consultas) [ESTIMATIVAS do memo D02]. Se a margem bruta ficar abaixo do que os sócios aceitarem, definir a cota de IA e mensagens por profissional antes de publicar.
4. Unidade: por profissional (A), plano individual (B); por paciente ativo só se a D1 trouxer TEA.
5. Registrar o **desconto de fundador** do piloto (plano de piloto §4) como % do preço de lista.

## 6. Modelo da página de conclusão (copiar, preencher e colar em `decisoes.md`)

```markdown
## Resultado das entrevistas D1/D2 — AAAA-MM-DD
**Amostra:** N entrevistas (A fisio/TO: n; B psicólogo: n; C TEA: n) entre DD/MM e DD/MM/AAAA. Conduzidas por: [sócios].
**Dados:** planilha anonimizada em `docs/01-mercado/kit-entrevistas/planilha-respostas.csv`; notas e áudios fora do git, exclusão em DD/MM/AAAA.
**Limite:** amostra pequena e por conveniência; sinal qualitativo [ESTIMATIVA].

### Hipóteses
| H | Resultado (n de N) | Status |
|---|---|---|
| H1 preço fisio | x de y aceitam R$ 129; x de y aceitam R$ 99 | C/R/I |
| H2 guia sem XML | x de y mistas | C/R/I |
| H4 contrato/suporte | ... | |
| H5 migração | ... | |
| H6 psicólogo < R$ 100 | ... (sinal) | |
| H7 repasse | ... | |
| H8 escriba | ... | |
| H10 gateway | ... | |
| H3/H9 TEA | ... (inconclusiva por desenho) | I |
| D14 Receita Saúde | ... | |

### Top 3 dores (com 1 citação anônima cada)
1. CÓDIGO — x de y — "citação"
2. ...
3. ...

### Preço
- Faixa aceitável cota A (PMC–PME): R$ __ a R$ __ por profissional/mês. Cota B: R$ __ a R$ __/mês.
- Gasto atual mediano: A R$ __/prof.; B R$ __/mês.

### Decisões propostas aos sócios
- **D1:** [manter opção A / reabrir] — condições atendidas: x de 4. Motivo em 1 linha.
- **D2:** preço de lista A R$ __/prof./mês; B R$ __/mês; tudo incluído com cota de IA de __ e de mensagens de __; desconto de fundador __%.
- **D14:** [lote / adiar] — motivo.

### Próximos passos
- Parceiras de design confirmadas: n (códigos E__).
- Lacunas que continuam abertas e como fechar.

Decidido por: [sócio 1] e [sócio 2] em DD/MM/AAAA.
```
