# Kit de entrevistas com clínicas (D1 nicho e D2 preço)

> Frente: Pesquisa de mercado (N2) · Versão 1.0 · 12/10/2026 · Quem usa: os sócios (N0)
> Base: hipóteses H1–H10 e roteiro do [relatório executivo §6](../relatorio-executivo-mercado.md), memos [D01](../../00-governanca/memos/D01-nicho-de-entrada.md), [D02](../../00-governanca/memos/D02-preco.md) e [D14](../../00-governanca/memos/D14-receita-saude-mvp.md), [plano de piloto](../../02-produto/plano-piloto.md) (onda 0 e §7) e [garantias](../../02-produto/garantias-ao-cliente.md).
> **Pendente:** revisão do Guardião LGPD no `consentimento.md` e nas regras de guarda abaixo antes da 1ª entrevista (AGENTS.md, regra 3).

## Os arquivos
| Arquivo | Para quê |
|---|---|
| [convite.md](convite.md) | 3 mensagens prontas (WhatsApp, e-mail, indicação) |
| [consentimento.md](consentimento.md) | Texto lido no início de cada entrevista + regras de dados |
| [roteiro.md](roteiro.md) | 30 min, cada pergunta ligada a uma hipótese H# |
| [planilha-respostas.csv](planilha-respostas.csv) | Uma linha por entrevista, só com código (sem nome) |
| [analise.md](analise.md) | Como consolidar, calcular o preço, decidir D1/D2 e o modelo de 1 página |

## Quem entrevistar (dono ou gestor que decide a compra do sistema)
| Cota | Perfil | Mínimo | Ideal | Hipóteses principais |
|---|---|---|---|---|
| **A** | Clínica de fisio ou TO com **2 a 10 profissionais**; pelo menos 2 **mistas** (atendem convênio) | 4 | 5 | H1, H2, H4, H5, H7 |
| **B** | **Psicólogo autônomo** (consultório próprio, pessoa física) | 2 | 3 | H6, H8, H10, D14 |
| **C** | Clínica **TEA/ABA** multiprofissional (contraste, não alvo da onda 1) | 1 | 2 | H3, H9 |
| | **Total** | **7** | **10** | |

Evitar: parentes, sócios ou amigos próximos (viés; mesma regra do piloto §3.2). Variar o sistema atual (ZenFisio, iClinic, PsicoManager, planilha/papel) e, se possível, a cidade (SP, RJ, MG primeiro, conforme o beachhead do relatório §5.1).

## Onde achar (sempre contato individual e manual)
1. **Indicações** (melhor canal): rede pessoal dos sócios e, ao fim de cada entrevista, pedir 1 ou 2 nomes (roteiro, bloco 9).
2. **Google Maps e sites de clínicas:** buscar "clínica de fisioterapia + bairro" e usar o **canal comercial público** da clínica (WhatsApp ou e-mail do site). Uma mensagem por clínica; sem resposta em 5 dias, um único lembrete; depois, parar.
3. **Instagram e LinkedIn:** mensagem direta a perfis profissionais de clínicas e psicólogos que divulgam atendimento.
4. **Conselhos regionais e associações (CREFITO, CRP, associações de especialidade):** usar eventos, cursos e grupos abertos para conhecer pessoas. **Não** extrair listas de inscritos dos sites dos conselhos.
5. **Grupos de WhatsApp/Facebook de profissionais:** só se um sócio já for membro e as regras do grupo permitirem; postar o convite uma vez, sem mensagem privada em massa.

**Proibido:** scraping ou robôs para coletar nomes, telefones ou e-mails (Google Maps, Instagram, sites de conselhos), compra de listas e disparo em massa. A lista de contatos fica numa planilha privada dos sócios, **fora do git**, e é apagada em 12 meses (consentimento.md §3).

## Cronograma de 2 semanas (sugestão: 13/10 a 26/10/2026)
| Quando | O quê |
|---|---|
| Dias 1–2 (13–14/10) | Guardião revisa o consentimento. Montar a lista privada de 25–30 contatos (cotas A, B e C) e enviar os convites. Fazer 1 entrevista de ensaio com um conhecido (não conta na amostra) |
| Dias 3–5 (15–17/10) | Entrevistas 1 a 4. Preencher o CSV **no mesmo dia** |
| Dia 6 (19/10) | Revisão do meio do caminho (30 min): cotas cumpridas? alguma pergunta confunde? Novos convites para as cotas faltantes |
| Dias 7–9 (20–22/10) | Entrevistas 5 a 10 |
| Dia 10 (23/10) | Consolidar com o `analise.md` |
| 26/10 | Reunião dos sócios: decidir D1, D2 (e D14) e registrar em `decisoes.md` |

Formato: videochamada ou presencial, 30 min, com **dois sócios**: um conduz, o outro anota. Sem demonstração de produto e sem venda.

## Quando D1 e D2 estão "decididos"
Contar só as cotas A e B (amostra principal, n = 7 a 8). A cota C serve de contraste e não muda D1 sozinha.

**D1, manter a opção A (fisio/TO + psicólogo autônomo; TEA na onda 2)** se as 4 condições valerem:
1. **Dor confirmada:** ≥ 6 de 8 (ou ≥ 75% da amostra principal) relatam, com **exemplo concreto do último mês**, pelo menos uma destas dores: controle de sessões/pacotes, guias de convênio, faltas, repasse ou cobrança.
2. **H2:** ≥ 60% das clínicas mistas da cota A dizem que operariam 6 meses sem o lote TISS XML.
3. **Troca possível:** ≥ 50% da amostra principal pensou em trocar de sistema nos últimos 12 meses ou usa planilha/papel (H4, H5).
4. **Compromisso:** ≥ 3 entrevistados aceitam ser parceiros de design (onda 0 do piloto).

Se 2 ou mais condições falharem, **reabrir a D1** antes do M1 (regra do memo D01). Se a cota C mostrar dor muito mais forte (H3 e H9 confirmadas nas 2 clínicas), registrar como sinal para antecipar a onda 2, sem trocar o nicho com n = 2.

**D2, adotar a opção A (R$ 99–129 por profissional/mês, tudo incluído)** se:
1. **H1:** ≥ 50% da cota A aceitam R$ 99–129 no Van Westendorp (cálculo em `analise.md` §3).
2. **Psicólogo (H6):** ≥ 50% da cota B aceitam um plano individual de **R$ 79–99/mês** [ESTIMATIVA de faixa, baseada nos concorrentes de R$ 39–119 em [psicologia §6](../nichos/psicologia-saude-mental.md)].
3. **G5:** ≥ 50% citam espontaneamente cobrança de extras (WhatsApp, IA, assinatura) como incômodo, **ou** pagam extras hoje.

Se H1 falhar, ajustar a faixa para a "faixa aceitável" medida (`analise.md` §3) e reavaliar a margem com o custo de IA e WhatsApp do memo D02.

> **Limite honesto:** 7 a 10 entrevistas dão **sinal qualitativo**, não estatística. Os critérios acima são regras de decisão combinadas antes, para evitar ler o resultado do jeito que se quer. Os percentuais desta página são critérios nossos, não dados de mercado.
