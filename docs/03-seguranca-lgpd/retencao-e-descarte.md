# Política de retenção e descarte (proposta para a D7)

> **Rascunho para o advogado (D8).** Não é parecer jurídico. ⚖️ = precisa de validação jurídica.
> Autor: agente `guardiao-lgpd` · Versão 0.1 · 10/10/2026 · Complementa [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) §6–§7 e a cláusula 12 do [DPA](dpa-minuta.md).
> **Legenda:** **FATO** = está na norma citada; **PROPOSTA** = escolha nossa, a decidir pelos sócios; **ESTIMATIVA** = número que ainda depende de medição ou cotação.

## 1. Decisão pedida aos sócios (D7)

| # | Pergunta | Proposta do Guardião |
|---|---|---|
| D7.1 | Por quanto tempo guardamos a **trilha de auditoria do prontuário**? | **Igual ao prontuário a que se refere** (20 anos do último registro), porque ela prova autoria e integridade do registro clínico (requisito SBIS de auditoria; defesa em processo ético ou judicial). ⚖️ |
| D7.2 | E a **auditoria administrativa** (login, configuração, exportação, eliminação)? | **5 anos**, alinhado ao prazo prescricional geral de reparação do CDC (art. 27) e ao registro de incidentes (Res. CD/ANPD 15/2024). ⚖️ |
| D7.3 | E os **registros de acesso à aplicação** (Marco Civil)? | Mínimo legal de **6 meses**; propomos **12 meses** em armazenamento quente e expurgo depois. A proposta anterior (5 anos) guardava IP e horário de todos os pacientes por tempo demais (minimização, LGPD art. 6º, III). |
| D7.4 | Quanto tempo os **backups** sobrevivem a uma eliminação? | Diários/PITR: **35 dias**; mensais imutáveis: **12 meses**. Meta técnica: **criptografia por clínica** para que a destruição da chave torne ilegíveis todas as cópias em até 7 dias (§4). |

## 2. Tabela de retenção

Os prazos contam a partir do evento indicado. "Controladora" e "operadora" se referem ao nosso papel ([papeis-controlador-operador.md](papeis-controlador-operador.md)).

### 2.1 Dados da clínica (somos operadora: a clínica decide, nós executamos)

| Dado | Prazo | Fundamento | Tipo |
|---|---|---|---|
| Prontuário médico e odontológico | **20 anos** a partir do último registro | Lei 13.787/2018, art. 6º (FATO); CFM Res. 1.821/2007; CFO (prontuário obrigatório, Código de Ética Odontológica) | FATO / ⚖️ prazo CFO |
| Prontuário de psicologia | **5 anos** no mínimo | CFP Res. 01/2009, art. 4º (FATO). **PROPOSTA:** a configuração padrão do tenant de psicologia é 5 anos, e a clínica pode estender | ⚖️ |
| Prontuário de fisioterapia/TO, nutrição e fonoaudiologia | **20 anos** (padrão conservador) até a matriz por conselho (J9) ser validada | PROPOSTA: usar a Lei 13.787 como teto por analogia | ⚖️ |
| Documentos assinados (receitas, atestados, laudos) e gravação de teleconsulta autorizada | Junto ao prontuário | Integram o prontuário (CFM Res. 2.314/2022, telemedicina) | FATO |
| Trilha de auditoria do prontuário | Igual ao prontuário (D7.1) | SBIS NGS1 (auditoria); prova de integridade | PROPOSTA |
| Agenda, contatos, mensagens fora do prontuário | Enquanto o paciente estiver ativo + **12 meses** | Minimização (LGPD art. 6º, III) | PROPOSTA |
| Rascunhos de IA não aceitos (prompts, áudio, transcrição) | **≤ 30 dias**; áudio do escriba apagado logo após a transcrição aceita | Minimização; [lgpd-e-ia.md](lgpd-e-ia.md) §7 | PROPOSTA |
| Financeiro da clínica (cobranças a pacientes, NFS-e) | **5 anos** | CTN arts. 173–174 (prazo decadencial e prescricional do crédito tributário) | FATO / ⚖️ confirmar com contador |

### 2.2 Dados próprios da plataforma (somos controladora)

| Dado | Prazo | Fundamento | Tipo |
|---|---|---|---|
| Registros de acesso à aplicação (IP, data e hora) | **12 meses** (mínimo legal de 6) | Marco Civil, art. 15 (FATO: 6 meses) | PROPOSTA (D7.3) |
| Auditoria administrativa da plataforma | **5 anos** | D7.2 | PROPOSTA |
| Registro de incidentes de segurança | **5 anos** | Res. CD/ANPD 15/2024, art. 10 (FATO) | FATO |
| Documentos fiscais e de cobrança da assinatura SaaS | **5 anos** | CTN arts. 173–174 | FATO / ⚖️ |
| Consentimentos e revogações coletados por nós | Duração do tratamento + **5 anos** | Ônus da prova do consentimento (LGPD art. 8º, §2º) | PROPOSTA ⚖️ |
| Certificado de eliminação de tenant e registro de que a exportação foi oferecida | **5 anos** após a eliminação | Prova do cumprimento da G3 e do DPA cl. 12 | PROPOSTA |
| Telemetria de produto (sem conteúdo clínico) | **13 meses**, agregada depois | Minimização | PROPOSTA |

## 3. Descarte durante o contrato

1. **A clínica não apaga prontuário antes do prazo:** "excluir" vira inativação, e o bloqueio técnico impede a remoção física antes do prazo (FATO de produto, já em [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) §7).
2. **Rotina anual:** o sistema lista os prontuários que venceram o prazo e a clínica aprova o descarte. A clínica pode reter por interesse histórico, judicial ou de pesquisa (Lei 13.787, art. 6º, §1º, permite a devolução ao paciente). ⚖️
3. **Como se apaga:** destruição da chave do registro (*crypto-shredding*) ou exclusão segura + registro do descarte (quem aprovou, quando e quantos registros, sem conteúdo clínico).
4. **Pedidos do titular (art. 18):** como operadora, encaminhamos à clínica em até 2 dias úteis (DPA cl. 8). A eliminação a pedido do titular **não** se aplica ao prontuário dentro do prazo legal (art. 16, I).

## 4. Descarte no fim do contrato (G3 e DPA cl. 12)

```
D0  cancelamento ──► modo leitura + exportação liberada (mín. 90 dias)
D+60 aviso (D-30) ─► D+83 aviso (D-7) ─► D+89 aviso (D-1)
D+90 eliminação em produção ─► agenda destruição da chave da clínica (KMS, espera de 7 dias)
D+97 chave destruída: cópias cifradas com ela ficam ilegíveis (quando houver criptografia por clínica)
D+125 último backup diário/PITR expira (35 dias)
até D+455 último backup mensal imutável expira (12 meses)
```

- **Antes de eliminar:** registrar que a exportação foi oferecida e se foi baixada (G3, EXP-01.6).
- **Custódia de guarda legal:** se a clínica contratar, nada é eliminado. Os dados ficam só em leitura, e o prazo segue a tabela 2.1.
- **Certificado de eliminação:** data da eliminação em produção, data da destruição da chave (se houver), **data de expiração da última cópia de backup**, categorias eliminadas e o que foi retido como controladora (tabela 2.2), sem conteúdo clínico.
- **Fatos técnicos usados:** o RDS guarda backups automáticos por no máximo **35 dias** ([AWS RDS — backups automáticos](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html), consultado em 10/10/2026); a exclusão de chave no KMS tem espera obrigatória de **7 a 30 dias** ([AWS KMS — deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html), consultado em 10/10/2026).

### 4.1 Expurgo de backups: o problema e a proposta

**FATO do desenho atual:** [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) §6 manda reter snapshots mensais por 12 meses, em cópia imutável (Object Lock) contra ransomware. Um backup imutável **não pode** ser editado para remover uma clínica. Por isso, sem outra medida, os dados de uma clínica eliminada continuam existindo, cifrados com a chave da plataforma, por até 12 meses.

| Opção | Efeito | Custo | Recomendação |
|---|---|---|---|
| A. Reduzir os mensais para 35 dias | Expurgo rápido | Perde a proteção de longo prazo contra ransomware e corrupção silenciosa | ❌ |
| B. Manter 12 meses e **declarar o prazo** no DPA, no certificado e no aviso de privacidade | Honesto e simples | Dado eliminado ainda existe em cópia por até 12 meses | ✅ **até a opção C existir** |
| C. **Criptografia por clínica** (chave própria no KMS por tenant para os campos pessoais e anexos) + destruição da chave na eliminação | Todas as cópias ficam ilegíveis em ~7 dias | Depende da criptografia de campo (S5 do relatório da rodada 7) | ✅ **meta do M0** |

**Regras para todas as opções:**
- backup restaurado nunca reintroduz clínica eliminada: a lista de tenants eliminados é reaplicada após qualquer restauração (teste obrigatório no runbook de restauração);
- o acesso aos backups é restrito, auditado e só ocorre em incidente ou teste de restauração.

## 5. Mecanismos (como o código faz valer)

| Regra | Mecanismo | Estado |
|---|---|---|
| Janela de saída ≥ 90 dias | Constante configurável e testada (PR #9) | ✅ |
| Bloqueio de exclusão de prontuário no prazo | Política no banco + teste | 📋 |
| Expurgo de logs de acesso aos 12 meses | Ciclo de vida do bucket/log group | 📋 |
| Destruição de chave por tenant | KMS por tenant + job de eliminação | 📋 (depende de S5) |
| Reaplicar eliminações após restauração | Passo do `backup-restore.mjs` + teste | 📋 |
| Certificado de eliminação | EXP-01.6 | 📋 |

## 6. Pontos para o advogado ⚖️

1. Prazo de guarda de prontuário para fisioterapia/TO, nutrição e fonoaudiologia (não há lei específica localizada; usamos 20 anos por analogia).
2. Se 5 anos de auditoria administrativa e 12 meses de logs de acesso são defensáveis.
3. Se declarar o prazo de 12 meses dos backups imutáveis basta como cumprimento da eliminação (art. 16 e DPA cl. 12) enquanto a opção C não existe.
4. Conflito entre o prazo mínimo da CFP (5 anos) e uma clínica multiprofissional que usa 20 anos para todos.

## 7. Fontes (consultadas em 10/10/2026)

- LGPD (Lei 13.709/2018), arts. 6º, 8º, 16 e 18: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm>
- Lei 13.787/2018 (prontuário digital), art. 6º: <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm>
- Marco Civil da Internet (Lei 12.965/2014), art. 15: <https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm>
- CTN (Lei 5.172/1966), arts. 173–174: <https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm>
- CDC (Lei 8.078/1990), art. 27: <https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm>
- CFM Res. 1.821/2007: <https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2007/1821>
- CFM Res. 2.314/2022 (telemedicina): <https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2022/2314>
- CFP Res. 01/2009: <https://site.cfp.org.br/?p=2570>
- Res. CD/ANPD 15/2024 (incidentes), publicada no DOU de 26/04/2024: <https://www.in.gov.br/en/web/dou/-/resolucao-cd/anpd-n-15-de-24-de-abril-de-2024-556243024>
- AWS RDS e KMS: links na §4.
