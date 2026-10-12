# D10 — Receita controlada (SNCR da Anvisa)
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com a frente Pesquisa · **Este memo não decide nada.**
> Origem: branch `pesquisa/necessidades-producao` (rodada 7), ainda não incorporado à `main`.

**Pergunta:** como o produto vai emitir receita de medicamento controlado e de antimicrobiano?
**Prazo sugerido:** antes de vender para nichos com médico (Portão C) · **Urgência:** Baixa para o nicho de entrada

## Contexto
A RDC Anvisa 1.000/2025 criou o SNCR (sistema nacional de controle de receituário) [FATO]:
- receita de controle especial e receita sujeita à retenção só valem se forem **natas digitais**, emitidas por sistema integrado ao SNCR via API;
- controle especial exige assinatura ICP-Brasil; retenção aceita assinatura avançada (gov.br);
- o prazo foi adiado para 30/09/2026, já vencido; há relatos de transição até 29/10/2026 e de problemas de acesso à API [A CONFIRMAR].

**Fisioterapeutas, terapeutas ocupacionais e psicólogos não prescrevem medicamentos.** Para o nicho de entrada, o tema não se aplica.

## Opções
| Opção | Custo | Prós | Contras/riscos |
|---|---|---|---|
| A. Integrar com parceiro já integrado ao SNCR e inscrito no CRM (Memed, Nexodata etc.) | Custo não levantado (contrato do parceiro) | Rápido; o parceiro carrega a obrigação regulatória | Dependência de terceiro; dado de prescrição sai para ele |
| B. Integrar direto à API do SNCR | Custo não levantado (engenharia + homologação) | Controle total | Exige inscrição no CRM (D11), API instável, manutenção regulatória |
| C. Não oferecer receita controlada no MVP | Zero | Foco no nicho de entrada | Limita a venda para medicina |

## Recomendação dos agentes
Recomendação, não decisão: **C no MVP e A quando houver nicho médico**, exigindo por contrato que o parceiro esteja integrado ao SNCR e inscrito no CRM. Critério de aceite de qualquer receita: o PDF passa no validador do ITI.

## O que trava se adiar
Nada no nicho de entrada. Trava a venda para clínicas com médico e o módulo `prescriptions` completo.

## Para decidir, falta
Confirmar com a Memed (e outro parceiro) a integração ao SNCR e o modelo de contrato; confirmar no DOU a prorrogação citada.

## Fontes
- Branch `pesquisa/necessidades-producao`: `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.8 e `docs/00-governanca/decisoes.md` (D10)
- [Anvisa: webinar RDC 1.000/2025 (fev/2026)](https://www.gov.br/anvisa/pt-br/assuntos/educacaoepesquisa/webinar/medicamentos/arquivos/webinar-rdc-1000-2025-visas-fev-2026-2-rdc-1000-alteracoes-da-portaria-34498-sobre-receituarios.pdf)
- `docs/04-arquitetura/integracoes.md` §4 e §5 (assinatura ICP-Brasil e Memed)
