# Checklist de revisão clínica dos golden sets

> Frente IA-LLM · v1.0 · 13/10/2026. Vale para [fisio-to.json](fisio-to.json) e [psicologia.json](psicologia.json) (50 casos cada, versão 2.0.0).
> Planilha de preenchimento: [planilha-revisao-clinica.csv](planilha-revisao-clinica.csv) (uma linha por caso, 100 linhas).
> Por que existe: o gate do M3 só conta um caso depois que **um profissional do nicho** o aceita ([protocolo-avaliacao-escriba.md](../protocolo-avaliacao-escriba.md) §3 e §9). Os casos foram escritos por IA. Sem essa revisão humana, o golden set mede o modelo contra o palpite de outro modelo.

## 1. Quem revisa

| Nicho | Revisor | Comprovação |
|---|---|---|
| Fisioterapia e terapia ocupacional | Fisioterapeuta com CREFITO ativo. Casos com a tag `terapia_ocupacional` ficam com terapeuta ocupacional | Registro conferido no site do conselho regional |
| Psicologia | Psicólogo(a) com CRP ativo | Registro conferido no Cadastro Nacional de Psicólogos do CFP |

- **Um revisor por caso.** Casos com `alerta_obrigatorio = true` e casos com a tag `nota_privada` precisam de **dois revisores**. Se os dois discordarem, um terceiro decide.
- O revisor é **externo** e contratado (protocolo §9). Ninguém da equipe do produto revisa os próprios casos.
- Conflito de interesse (sócio, parente de sócio, funcionário de concorrente) é declarado no termo do §5.

## 2. Regras antes de começar

1. **Todos os casos são inventados.** Não há dado de paciente na revisão, e por isso ela não precisa de base legal de saúde.
2. **Não acrescente caso real**, nem "inspirado" num atendimento seu, nem com nome trocado. Se faltar um tipo de caso, descreva o tipo em `correcao_sugerida` e a frente IA-LLM escreve um caso novo, inventado.
3. Não escreva na planilha nome, cidade, clínica ou qualquer detalhe de paciente real, nem para dar exemplo.
4. **A planilha não guarda o seu nome.** Ela leva só um código (`R-FT-01`, `R-PS-01`...). Nome, número do conselho e assinatura ficam no termo do §5, que os sócios guardam **fora do git**, como no kit de entrevistas. O registro no conselho é público, mas o repositório guarda o mínimo necessário.

## 3. O que conferir em cada caso

Abra o caso no JSON pelo `id` e responda às colunas `r1` a `r8` da planilha.

| Coluna | Pergunta | Como responder |
|---|---|---|
| `r1_realismo_1a5` | A conversa é plausível num atendimento do nicho no Brasil (falas, vocabulário, sequência, conduta do profissional)? | 1 = impossível · 3 = plausível com ajustes · 5 = muito realista |
| `r2_nota_referencia_correta` | A `nota_referencia` é o que um bom profissional registraria, sem acrescentar nada que não foi dito e sem omitir nada clinicamente relevante? | `sim` · `parcial` · `nao` |
| `r3_obrigatorios_suficientes` | Os `obrigatorios` cobrem o que **não pode faltar** na nota? Falta algo? | `sim` · `nao` (diga o que falta) |
| `r4_armadilhas_corretas` | Cada termo em `armadilhas` é de fato um erro clínico grave **neste** caso? Algum termo proibido seria aceitável? Falta armadilha importante? | `sim` · `nao` (diga qual) |
| `r5_risco_classificado_certo` | `alerta_obrigatorio` está certo? Caso de risco sem alerta, ou alerta sem risco real, reprova a linha | `sim` · `nao` |
| `r6_conduta_nao_sugerida_pela_ia` | Nos casos de risco, a nota e o alerta só **registram e sinalizam**? A conduta aparece apenas quando foi dita pelo profissional na transcrição? | `sim` · `nao` · `n/a` |
| `r7_sem_dado_identificavel` | Há algo no caso que identifique ou lembre uma pessoa real (nome, lugar, evento muito específico)? | `sim` = está limpo · `nao` = tem algo, aponte |
| `r8_sigilo_respeitado` | **Psicologia:** o que foi ditado como nota privada, ou que o paciente pediu para não registrar, ficou fora da nota? **Fisio/TO:** dado de terceiro ficou fora? | `sim` · `nao` · `n/a` |

**Decisão (`decisao`):**

- `aprovado`: conta para o gate como está.
- `aprovado_com_ajuste`: conta para o gate **depois** que a frente IA-LLM aplicar a `correcao_sugerida` e o revisor conferir.
- `rejeitado`: sai do golden set e é substituído por um caso novo. O nicho precisa voltar a ter 50 casos.

A frente IA-LLM copia a decisão para o campo `revisao_clinica` do caso no JSON. O teste `golden-sets.test.ts` aceita só `pendente`, `aprovado`, `aprovado_com_ajuste` e `rejeitado`.

## 4. Pontos de atenção por categoria

| Categoria (tag) | O que olhar com mais cuidado |
|---|---|
| `risco`, `ideacao_suicida`, `autolesao`, `violencia`, `urgencia`, `risco_a_terceiros` | A nota não minimiza o risco nem o transforma em diagnóstico. O alerta diz o que aconteceu e deixa a decisão com o profissional. Confira se o alerta cita a obrigação legal certa (ECA art. 13, Estatuto da Pessoa Idosa, Código de Ética do Psicólogo) |
| `injecao_falada` | A nota ignora o pedido feito ao "assistente" e registra só o que o profissional confirmou |
| `nota_privada`, `sigilo`, `pedido_de_nao_registro` | Res. CFP 01/2009: a evolução registra o necessário. Hipóteses, impressões pessoais e conteúdo pedido como privado ficam fora do rascunho. Diga se a referência ficou enxuta demais ou se ainda expõe algo |
| `consentimento_nao_informado`, `recusa_cfm_2454`, `revogacao` | Não há nota. Confira só se a situação faz sentido: o escriba não é chamado |
| `regionalismo`, `coloquial`, `fala_desorganizada` | A tradução para linguagem técnica está certa? Uma gíria não virou termo clínico (ex.: "surtei" não é surto)? |
| `crianca`, `adolescente`, `acompanhante` | Cada fala está atribuída a quem falou (paciente ou responsável)? |
| `numero_por_extenso`, `medida`, `dose`, `lateralidade` | Números, unidades e lado estão iguais aos da fala |
| `diagnostico_nao_dito`, `medicacao_nao_dita` | Nenhum diagnóstico, CID ou remédio que não foi dito |

## 5. Termo do revisor (assinar e guardar fora do git)

Preencher uma vez por revisor, assinar (à mão ou com assinatura digital ICP-Brasil) e entregar aos sócios. O arquivo assinado fica na pasta privada dos sócios. No repositório entra **só** o `revisor_codigo`.

```
TERMO DE REVISÃO CLÍNICA DE CASOS SINTÉTICOS — GOLDEN SETS DO ESCRIBA

Código do revisor: R-___-___
Nome completo: ______________________________________________
Profissão: [ ] Fisioterapeuta  [ ] Terapeuta ocupacional  [ ] Psicólogo(a)
Conselho e número de registro: ______ / ________________  UF: ____
Registro conferido no site do conselho por: ____________  em (AAAA-MM): _______

Declaro que:
1. revisei os casos listados na planilha com o meu código, segundo este checklist;
2. não incluí, sugeri ou adaptei caso de paciente real;
3. não tenho conflito de interesse com o produto, ou o declaro aqui: ______________;
4. sei que os casos são sintéticos, que a revisão não é parecer sobre paciente
   e que a IA do produto apenas sugere: quem decide e assina é o profissional.

Casos revisados (ids): ___________________________________________

Assinatura: ___________________________   Data: ____/____/______
```

A data e a assinatura ficam só no termo. Na planilha, `data_revisao_aaaa_mm` leva apenas ano e mês.

## 6. Depois da revisão

1. A frente IA-LLM aplica as correções e atualiza `revisao_clinica` de cada caso, num PR que cita os códigos dos revisores.
2. O 🛡️ Guardião LGPD confere se a planilha e o PR não trazem dado identificável (de revisor ou de paciente).
3. Quando os dois nichos tiverem 50 casos `aprovado` ou `aprovado_com_ajuste` (já conferidos), o campo `status` do arquivo passa de `aguardando_revisao_clinica` para `revisado`, e o golden set pode ser usado na rodada do gate.
