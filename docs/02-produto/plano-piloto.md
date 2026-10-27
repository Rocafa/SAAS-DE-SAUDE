# Plano de piloto (beta) com clínicas

> Frente: 🧩 Produto (N2) · Versão 0.1 · Data: 2026-10-08
> Base: [roadmap.md](./roadmap.md) (piloto mar–jun/2027, GA com 30 clínicas) · [metricas-produto.md](./metricas-produto.md) · [definicao-de-pronto.md](./definicao-de-pronto.md) · [docs/03-seguranca-lgpd/](../03-seguranca-lgpd/)
> Datas e números são **ESTIMATIVAS** de planejamento. O nicho de entrada depende da decisão **D1** ([decisoes.md](../00-governanca/decisoes.md)); este plano funciona para as duas opções.

## 1. Objetivos do piloto

1. Provar que o núcleo (agenda → atendimento → prontuário assinado) é usado toda semana: **North Star CCPA/semana**.
2. Validar os diferenciais: WhatsApp (no-show ↓), escriba de IA (tempo de documentação ↓), Pix + NFS-e (receber rápido), migração assistida e exportação total.
3. Validar o modelo de dados por nicho (modelos de prontuário, sessões recorrentes, pacotes).
4. Operar LGPD de verdade: DPA, consentimentos, direitos do titular, incidentes — **zero incidente**.
5. Validar preço (D2) e disposição de conversão para pago.

## 2. Pré-requisitos inegociáveis (antes de qualquer dado real)

| # | Pré-requisito | Dono | Evidência |
|---|---|---|---|
| P1 | **Gate LGPD do M1** aprovado: RIPD do produto (LGP-03.2), **RIPD específico do piloto** (base: Anexo A de `docs/03-seguranca-lgpd/revisoes/2026-10-08-pr5.md`, cobrindo onboarding com dado real, migração, menores, impersonação de suporte e entrevistas), consentimentos (LGP-01.2), retenção (LGP-03.3) | Guardião LGPD | Os dois RIPDs assinados, ata do gate |
| P2 | Pentest externo do núcleo sem achado crítico/alto aberto | Engenharia + Guardião | Relatório do pentest e plano de correção |
| P3 | Plano de incidentes (LGP-03.4) testado em *tabletop* | Guardião | Ata da simulação |
| P4 | **Contrato de operador (DPA) assinado com cada clínica** (LGP-01.4), com lista de suboperadores e termo de piloto | Produto + jurídico (D8) | DPA assinado/aceito por versão |
| P5 | Validação jurídica dos itens ⚖️ (D8) — CFM 2.454/2026, DPA, termo de piloto | Sócios | Parecer do advogado |
| P6 | Escriba de IA **somente** após RIPD do escriba e gate de avaliação (IA-05.3) do nicho; provedor com contrato de não retenção e dados no Brasil (D3). **No piloto, só provedor com processamento no Brasil**; provedor estrangeiro, depois do piloto, apenas com dado pseudonimizado + cláusulas-padrão ANPD, e nunca para psicologia | IA + Guardião | Ata do gate M3 |
| P7 | Ambiente de produção na AWS São Paulo com backup testado (NUC-05.6) e monitoração (NUC-05.5) | Engenharia / DevOps | Relatório de restauração |

**Antes de P1–P5:** as clínicas só usam um ambiente **sandbox com dados sintéticos** (treino, validação de modelos de prontuário, testes de usabilidade). É proibido importar, digitar ou anexar dado real de paciente no sandbox; nenhum dado real em prints de feedback.

## 3. Seleção de clínicas

### 3.1 Número e ondas

| Onda | Quando (est.) | Clínicas | Perfil | Escopo liberado |
|---|---|---|---|---|
| **0 — Parceiras de design** | M0–M1 (nov/2026–fev/2027) | 5 | Clínicas próximas, dispostas a co-desenhar | Sandbox com dados sintéticos; entrevistas; validação de modelos por nicho |
| **1 — Piloto fechado** | após Gate LGPD (≈ mar/2027) | 8 (as 5 da onda 0 + 3) | Pequenas, particular-first | Núcleo M1 + WhatsApp (M2) com dados reais. **Sem importação de base de concorrente nesta onda** (a migração é do M4) |
| **2 — Piloto ampliado** | ≈ abr/2027 | +10 (total 18) | Inclui ≥ 5 migrando de concorrente | + documentos e escriba nos nichos liberados (M3) |
| **3 — Beta aberto controlado** | ≈ mai–jun/2027 | +12 (total 30) | Mix de tamanhos e cidades | + financeiro, Pix, NFS-e, portal, migração (M4) |

Meta: **30 clínicas ativas** no fim (critério de GA do roadmap); recrutar ~40 prevendo ~25% de desistência.

### 3.2 Critérios de seleção

**Obrigatórios**
- Clínica ou consultório com **1 a 10 profissionais**, majoritariamente particular (TISS fica para a Fase 2).
- Nicho dentro da opção escolhida em D1:
  - **Opção (a):** psicologia, nutrição, fisioterapia e clínicas multiprofissionais;
  - **Opção (b):** TEA/ABA, fono, fisio/TO.
  - Em ambas, priorizar o núcleo comum: **sessões recorrentes, pacotes e repasse**.
- Responsável legal (controlador) disposto a assinar **DPA e termo de piloto** e a nomear um encarregado/ponto focal de privacidade.
- Usa WhatsApp com pacientes e aceita migrar para o número oficial (WhatsApp Business Platform).
- Compromisso de uso: agenda e prontuário **100% na plataforma** durante o piloto (não em paralelo com papel).
- Dono e ≥ 1 profissional disponíveis para 1 entrevista a cada 2 semanas.

**Desejáveis (para diversidade da amostra)**
- ≥ 5 clínicas migrando de concorrente (iClinic, Feegow, Ninsaúde ou planilha) — testa MIG-01.* (dependência D10 do roadmap).
- ≥ 3 clínicas com recepção dedicada (persona Juliana) e ≥ 3 autônomos sem secretária.
- ≥ 2 cidades com emissão de NFS-e em municípios diferentes (FIS-01).
- Pelo menos 1 clínica com atendimento de menores (responsáveis legais, PAC-01.2). O RIPD do piloto deve tratar o melhor interesse da criança (LGPD art. 14) e a representação pelos responsáveis. **O escriba de IA fica bloqueado para menores** até o RIPD do escriba cobrir esse caso.

**Exclusão**
- Clínicas dependentes de faturamento TISS (> 40% da receita via convênio).
- Clínicas com incidente de dados não resolvido ou sem CNPJ/registro regular.
- Parentes/sócios de membros do time (viés de feedback).

## 4. Duração e cronograma

- **Duração:** 16 semanas com dados reais (≈ mar → jun/2027), precedidas de 8–12 semanas de onda 0 em sandbox.
- **Condição comercial:** gratuito durante o piloto; ao fim, desconto de fundador (preço a definir em D2) e **saída sem multa** com exportação total (EXP-01).
- **Revisões:** semana 4 (linha de base medida), semana 8 (decisão de ampliar para onda 2/3), semana 16 (decisão de GA).

## 5. Onboarding

| Etapa | O que acontece | Responsável | Duração alvo |
|---|---|---|---|
| 1. Contratação | Termo de piloto + **DPA** + política de privacidade e termos (LGP-01.3/01.4) aceitos por versão; nomeação do ponto focal de privacidade | Produto + clínica | 1 dia |
| 2. Kickoff | Reunião de 45 min: objetivos, métricas, canal de feedback, regras de dado real | CS do piloto | 1 dia |
| 3. Configuração | Wizard (NUC-01.2): dados da clínica, nicho, profissionais, horários; convites; **MFA obrigatório** para acesso clínico | Clínica, com apoio | < 1 dia |
| 4. Modelos | Seleção de modelos por nicho (PRO-01.3) e ajuste fino com o profissional | CS + consultor do nicho | 1–2 dias |
| 5. Migração (**só a partir da onda 3 / M4**) | Importação assistida com *dry-run* e divergências (MIG-02), somente depois de: DPA aceito, termo de migração (MIG-02.4), canal de transferência cifrado e descarte evidenciado do arquivo bruto em até 7 dias | Time de migração | ≤ 5 dias úteis |
| 6. Canais | Conexão do número WhatsApp oficial, templates, opt-in (COM-01) | CS + clínica | 3–10 dias (aprovação Meta) |
| 7. Consentimentos | Modelos de termos aos pacientes (escriba, imagem, marketing) configurados (LGP-01.2) | Clínica (controladora) | 1 dia |
| 8. Treinamento | 2 sessões de 1 h (recepção; profissionais) + central de ajuda (SUP-01.1). Na sessão da recepção/financeiro, item obrigatório (R8 do parecer #65): **não descrever o atendimento na mensagem do Pix nem da transferência** (nada de "sessão de psicoterapia" ou especialidade) — o texto fica no extrato do banco, fora do sistema. O mesmo aviso aparece na tela de recebimento (`aviso` do recebimento Pix/transferência, `AVISO_PIX_MANUAL`) | CS | 1 semana |
| 9. Go-live | Primeira semana com acompanhamento diário (*hypercare*) | CS + Engenharia de plantão | 1 semana |

## 6. Critérios de sucesso para GA

O GA é decidido pelos sócios (N0) quando **todos** os critérios abaixo estiverem atendidos:

| # | Critério | Linha de corte |
|---|---|---|
| G1 | Clínicas piloto ativas (≥ 1 CCPA/semana nas últimas 4 semanas) | ≥ 25 (meta 30) |
| G2 | North Star medida semanalmente e automatizada (ADM-01.6) | Sim, há ≥ 8 semanas |
| G3 | CCPA/semana do piloto | ≥ 1.500 |
| G4 | No-show vs. linha de base | ≤ −10% |
| G5 | Escriba: gate de avaliação aprovado nos nichos lançados; aceite do rascunho | ≥ 40% |
| G6 | Clínicas que aceitam virar pagantes | ≥ 60% |
| G7 | NPS das clínicas | ≥ 30 |
| G8 | Disponibilidade | ≥ 99,9% por 4 semanas consecutivas |
| G9 | Incidentes com dados pessoais | **0** |
| G10 | Pentest final sem achado crítico/alto aberto; RIPD do produto e do escriba aprovados | Sim |
| G11 | Bugs críticos abertos (perda de dado, vazamento entre tenants, assinatura inválida) | 0 |
| G12 | Exportação total testada em ≥ 3 clínicas reais | Sim |
| G13 | Guardião LGPD ✅ e sócios ✅ | Sim |

Se G1–G7 não forem atingidos mas G8–G13 sim: estender o piloto por até 8 semanas com plano de corte de escopo (roadmap §8).

## 7. Coleta de feedback

| Canal | Frequência | O que coleta | Cuidados LGPD |
|---|---|---|---|
| Analytics de produto ([metricas-produto.md](./metricas-produto.md) §5) | Contínuo | Uso, funil, North Star | Somente eventos sem dado pessoal |
| Entrevistas estruturadas (dono, profissional, recepção) | Quinzenal, 30 min | Dores, valor percebido, disposição a pagar | Gravação só com consentimento do entrevistado; nunca mostrar tela com paciente real. Nesse tratamento somos controladores: finalidade registrada no ROPA, **retenção de 12 meses**, armazenamento no Brasil com acesso restrito |
| Botão "dar feedback" in-app | Contínuo | Ideias e problemas | Captura de tela **bloqueada em telas com dado de paciente** até o mascaramento (SUP-01.3) ser validado; depois, o mascaramento vira só um recurso de reserva, não o padrão |
| Chat de suporte (SUP-01.2) | Contínuo | Problemas | Mascaramento de dado de saúde em tickets |
| NPS da clínica e do paciente (CRM-01) | Mensal / pós-atendimento | Satisfação | Paciente responde via template sem informação clínica |
| Teste de usabilidade moderado | Por marco, 5 usuários | Tarefas-chave (agendar, atender, assinar, cobrar) | Sandbox com dados sintéticos |
| Grupo de parceiros (comunidade) | Mensal | Priorização do roadmap | Proibido compartilhar dado de paciente no grupo; regra no termo de piloto |

Todo feedback vira item rastreável (tag `piloto`) no backlog, triado semanalmente por Produto; padrões que afetem LGPD vão ao Guardião.

## 8. Cuidados LGPD específicos do piloto

1. **Contrato de operador antes de qualquer dado real** (P4). Sem DPA aceito, o sistema bloqueia o cadastro de pacientes (HU-LGP-003).
2. A **clínica é a controladora**; nós somos operadores. Não usamos dados do piloto para treinar IA (passaríamos a controladores) — fine-tuning só na Fase 2, com dados anonimizados e opt-in.
3. **Acesso interno mínimo:** ninguém do time acessa produção sem aprovação (ADM-01.7); suporte usa impersonação auditada com autorização do cliente e conteúdo clínico mascarado (ADM-01.2).
4. **Consentimentos do paciente** coletados pela clínica antes de gravação/escriba e fotos (LGP-01.2); o paciente pode recusar a IA (CFM 2.454/2026).
5. **Dados sensíveis de IA:** durante o piloto, **somente provedor com processamento no Brasil** (D3, LGP-03.8), em linha com o P6; psicologia nunca sai do país.
6. **Incidente:** plano testado. **Nós (operadores) avisamos a clínica em até 24 h** (`papeis-controlador-operador.md`); a clínica, como controladora, comunica a ANPD e os titulares em até 3 dias úteis, com o nosso apoio. Contato do encarregado de cada clínica sempre atualizado.
7. **Saída do piloto:** clínica que desistir recebe exportação total e tem os dados eliminados conforme DPA, preservando o que a lei obriga guardar (prontuário 20 anos) sob responsabilidade da controladora.
8. **Material de divulgação:** depoimentos e casos só com autorização escrita da clínica e sem nenhum dado de paciente.

## 9. Riscos do piloto

| Risco | Mitigação |
|---|---|
| Gate LGPD atrasa e clínicas perdem interesse | Onda 0 em sandbox mantém engajamento; comunicar a data só após pentest |
| Aprovação da Meta demora | Iniciar na semana 1 (roadmap D3); fallback SMS/e-mail (COM-04) |
| Uso em paralelo com sistema antigo | Critério de compromisso de uso 100%; migração assistida |
| Escriba reprovado em algum nicho | Liberar por nicho; demais usam modelos manuais |
| Amostra enviesada para um só nicho | Cotas por nicho conforme D1 |
