# D7 — Retenção da trilha de auditoria (e dos registros clínicos)
> Memorando para decisão dos sócios (N0) · 10/10/2026 · preparado pelo Maestro com o Guardião LGPD · **Este memo não decide nada.**

**Pergunta:** por quanto tempo guardamos a trilha de auditoria, e como ela convive com os prazos de guarda de cada conselho?
**Prazo sugerido:** antes do piloto com dado real (Portão B) · **Urgência:** Média

## Contexto
A tabela `audit_log` já existe, é append-only e não pode ser alterada nem apagada nem pelo dono do banco. Falta a política de retenção. A rodada 7 mostrou que os prazos de guarda **variam por conselho** [FATO]:
- prontuário em geral: 20 anos a partir do último registro (Lei 13.787/2018);
- registros psicológicos: mínimo de 5 anos, com destruição orientada depois (Res. CFP 001/2009);
- regra do COFFITO não encontrada;
- incidentes de segurança: registro por 5 anos (Res. CD/ANPD 15/2024).

## Opções
| Opção | Custo | Prós | Contras/riscos |
|---|---|---|---|
| A. Auditoria por 5 anos, fixo | Armazenamento baixo (custo não levantado) | Simples | Pode durar menos que o prontuário que ela audita (20 anos) |
| B. Auditoria acompanha o registro auditado: mesmo prazo do registro, com piso de 5 anos | Mais armazenamento e lógica por tipo | Prova de acesso existe enquanto o dado existe | Mais complexo; exige tabela de temporalidade |
| C. Auditoria permanente | Armazenamento cresce sem fim | Nada se perde | Fere minimização (LGPD); custo |

## Recomendação dos agentes
Recomendação, não decisão: **opção B**, com uma **tabela de temporalidade por tipo de registro e por conselho** configurável (não um número fixo no código). A eliminação certificada da garantia de saída (EXP-01.6) precisa respeitar essa tabela. ⚖️ O advogado (D8) deve validar os prazos e quem guarda o quê depois do cancelamento da clínica.

## O que trava se adiar
- Portão B do piloto (política de retenção é item obrigatório).
- Microparte EXP-01.6 (eliminação após a janela de saída).
- RIPD do produto (prazo de retenção é campo obrigatório).

## Para decidir, falta
Regra de guarda do COFFITO; parecer jurídico sobre clínica multiprofissional (vale o maior prazo?).

## Fontes
- `docs/03-seguranca-lgpd/README.md` (linha 13, Lei 13.787/2018)
- `docs/relatorios/2026-10-10-rodada-7-necessidades-producao.md` §3.10 e §3.11 (branch `pesquisa/necessidades-producao`)
- [CFP: guarda e descarte](https://site.cfp.org.br/faq/como-devo-fazer-guarda-e-descarte-de-documentos-utilizados-no-atendimento/)
- `apps/api/db/migrations/0002_garantia_de_saida.sql` (`audit_log`)
