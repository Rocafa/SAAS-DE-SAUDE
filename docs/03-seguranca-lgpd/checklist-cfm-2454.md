# Checklist da Res. CFM 2.454/2026 para as features de IA

> **Rascunho para o advogado (D8).** ⚖️ = precisa de validação jurídica.
> Autor: agente `guardiao-lgpd` · Versão 0.1 · 10/10/2026.
> **Base: texto oficial da resolução** (PDF do CFM com a retificação do DOU de 05/03/2026), lido nesta rodada. Até agora o repositório só tinha resumos de escritórios ([avaliacao-e-seguranca.md](../05-ia-llm/avaliacao-e-seguranca.md) §5.2).
> **Legenda:** **FATO** = texto da resolução; **NOSSA LEITURA** = como aplicamos ao produto; **NOSSA REGRA** = escolha nossa além da norma.

## 1. Fatos básicos

- **Resolução CFM nº 2.454, de 11/02/2026**, "normatiza o uso da inteligência artificial na medicina". Publicada no DOU em 27/02/2026 (ed. 39, seção 1, p. 158) e retificada em 05/03/2026 (ed. 43, seção 1, p. 91). FATO.
- **Vigência:** "após decorridos 180 dias da data de sua publicação" (art. 23). FATO. NOSSA LEITURA: em vigor desde **26/08/2026**, contando 180 dias a partir de 27/02/2026. Algumas análises falam em setembro ⚖️.
- **A quem se aplica:** a médicos e a instituições médicas que desenvolvem, contratam ou usam IA (arts. 1º, 12 e 14), inclusive aos sistemas **já em uso** na data da vigência (art. 21). FATO.
- **Quem fiscaliza:** o CRM da jurisdição (art. 15). FATO.
- **Outras profissões:** a resolução é do CFM. NOSSA REGRA: aplicar o mesmo padrão a todos os nichos (fisio, psico, nutrição, odonto), como já decidido em [avaliacao-e-seguranca.md](../05-ia-llm/avaliacao-e-seguranca.md) §5.2.

## 2. Quem é quem

Nós **fornecemos** a IA; a **clínica** (instituição médica) contrata e usa; o **médico** responde pelo ato. As obrigações dos arts. 12 e 14 (avaliação de risco e governança) são da instituição e do médico. Por isso o produto precisa **entregar o material** para que eles cumpram essas obrigações (NOSSA LEITURA ⚖️).

## 3. Checklist por artigo

Marcar em cada feature de IA (escriba, resumo do paciente, sugestão de CID/TUSS, extração de exames, chatbot). **Estado:** ❌ não feito · 📋 previsto em documento · ✅ implementado e testado. Hoje **nenhuma feature de IA existe no código** (FATO do repositório), então todos os itens estão ❌ ou 📋.

| # | Artigo (FATO) | Requisito de produto (NOSSA LEITURA) | Estado |
|---|---|---|---|
| C1 | Art. 4º, I; art. 15, par. único; art. 18, §§1º–2º: IA só como apoio; supervisão humana obrigatória; decisão sempre do médico | Toda saída é **rascunho** que o profissional aceita, edita ou descarta. Nada grava no prontuário, vai ao paciente ou ao convênio sem aceite explícito | 📋 [casos-de-uso.md](../05-ia-llm/casos-de-uso.md) |
| C2 | Art. 4º, V: "registrar no prontuário do paciente o uso de sistemas de IA como apoio à decisão médica" | Marca automática no registro: feature, modelo e versão, data e hora e quem aceitou. Visível na impressão e na exportação | 📋 |
| C3 | Art. 5º, §1º; art. 11: paciente informado quando a IA é apoio relevante; "qualquer utilização" comunicada e explicada | Aviso ao paciente no portal e no termo da clínica; texto-modelo que diz que a IA apoia e não substitui o médico | ❌ |
| C4 | Art. 5º, §3º: respeitar a **recusa informada** do paciente | Campo "paciente recusa IA" que **bloqueia** escriba, resumo e sugestões para aquele paciente, com registro no prontuário | 📋 |
| C5 | Art. 5º, §2º: vedado delegar à IA a comunicação de diagnóstico, prognóstico ou decisão terapêutica sem mediação humana | Chatbot e portal **nunca** entregam conteúdo clínico gerado por IA sem aprovação do profissional. Teste automatizado bloqueia | 📋 |
| C6 | Art. 6º, §1º: compartilhar com a IA só o estritamente necessário e para a finalidade informada | Gateway de IA com minimização e pseudonimização; nada além do contexto do atendimento | 📋 [arquitetura-ia.md](../05-ia-llm/arquitetura-ia.md) |
| C7 | Art. 6º, §2º; art. 16: treino e validação observam a proteção de dados | Treino vedado por padrão (DPA cl. 10); só anonimizado e com opt-in | 📋 [dpa-minuta.md](dpa-minuta.md) |
| C8 | Art. 6º, §3º; art. 17: vedado usar IA sem padrões mínimos de segurança; proteção contra perda, alteração e vazamento | Provedor no Brasil ou pseudonimizado; não-treino e retenção curta por contrato; **recusa de endpoint global** para dado sensível (relatório da rodada 7, §3.5) | ❌ |
| C9 | Art. 3º, II: o médico tem direito a informações claras sobre funcionamento, finalidades, limitações, riscos e evidência | **Ficha do modelo** por feature (finalidade, dados usados, limitações, métricas, vieses conhecidos) acessível ao médico e ao diretor técnico | 📋 |
| C10 | Art. 3º, III–IV; art. 19: médico pode recusar ou desligar a IA, sem penalidade; a instituição não impõe metas | Interruptor por profissional e por clínica; o produto **não** mede nem expõe "taxa de uso de IA" por médico em painel gerencial | ❌ (NOSSA REGRA) |
| C11 | Art. 7º, §2º: dever de comunicar falhas e riscos relevantes | Botão "reportar erro da IA" no rascunho, que vai para a fila de qualidade sem conteúdo clínico identificável | ❌ |
| C12 | Art. 7º, §3º: uso de IA com finalidade publicitária segue as regras de publicidade médica (Res. CFM 2.336/2023) | Nada de "IA que diagnostica" no marketing; revisão do texto comercial pelo advogado ⚖️ | ❌ |
| C13 | Art. 9º, §§1º–2º: compatibilidade ética em todo o ciclo de vida; instituições implementam **auditoria e monitoramento contínuos** | Eval antes de cada deploy e monitoramento em produção ([avaliacao-e-seguranca.md](../05-ia-llm/avaliacao-e-seguranca.md) §1 e §4); relatório periódico para a clínica | 📋 |
| C14 | Arts. 12–13 e Anexo II: avaliação preliminar de risco (baixo, médio, alto, inaceitável), **informada ao usuário** | Classificação por feature (§4) publicada na ficha do modelo e na tela de ativação | ❌ |
| C15 | Art. 14 e Anexo III: processos de governança; **Comissão de IA e Telemedicina** quando a instituição adota sistema **próprio**; diretor técnico responsável | Entregar à clínica um **kit de governança**: ficha do modelo, classificação de risco, relatório de monitoramento e modelo de termo. A clínica que só contrata não precisa de comissão (NOSSA LEITURA ⚖️) | ❌ |
| C16 | Anexo III, II: monitorar vieses com resultados estratificados; corrigir ou descontinuar | Evals estratificados por faixa etária, sexo e nicho, só com dados sintéticos | 📋 |
| C17 | Anexo III, VIII: acesso de órgãos de controle (CRM, MP) a relatórios de auditoria e configuração | Pacote de evidências exportável por feature e versão | ❌ |
| C18 | Anexo III, IV e VII: interoperabilidade e padrões abertos | Saídas estruturadas e exportáveis (JSON/FHIR na Fase 2), coerentes com a G2 | 📋 |

## 4. Classificação de risco proposta (Anexo II) ⚖️

| Feature | Risco proposto | Por quê (Anexo II) |
|---|---|---|
| Agendamento inteligente, lembretes | **Baixo** | Função administrativa, sem influência em diagnóstico ou tratamento (exemplo citado no próprio anexo) |
| Chatbot de informações gerais da clínica | **Baixo**, se não personalizar conselho clínico | O anexo cita chatbots de informação geral como baixo risco. Se responder sobre o caso do paciente, deixa de ser baixo |
| Escriba (áudio para evolução) | **Médio** | Apoia o registro clínico; erros podem ser detectados e corrigidos pelo profissional antes de causar dano |
| Resumo do paciente | **Médio** | Apoia decisão, sem executá-la |
| Extração de dados de exames | **Médio** | Erro de transcrição pode induzir conduta; exige conferência |
| Sugestão de CID/TUSS | **Médio a alto** ⚖️ | Influencia diagnóstico e faturamento. **Fica fora do MVP** até o parecer sobre SaMD (J8) |
| Qualquer IA que comunique diagnóstico ao paciente ou aja sem humano | **Inaceitável no nosso produto** | Vedado pelo art. 5º, §2º e pelo art. 18 |

**Regras do Anexo II, §§1º–2º (FATO):** baixo risco tem revisão periódica e pode ser reclassificado; médio risco exige monitoramento regular e avaliação de desempenho e viés. NOSSA REGRA: revisar a classificação a cada troca de modelo ou de finalidade.

## 5. Gate de go-live de uma feature de IA

Uma feature de IA só vai para produção com:
- [ ] C1, C2, C4 e C5 ✅ com teste automatizado;
- [ ] ficha do modelo (C9) e classificação de risco (C14) publicadas;
- [ ] eval aprovado ([avaliacao-e-seguranca.md](../05-ia-llm/avaliacao-e-seguranca.md) §6), com recorte de viés (C16);
- [ ] provedor aprovado na D3, com contrato de não-treino e residência (C8);
- [ ] RIPD da IA assistiva (Anexo A, item 6 do [modelo](RIPD-modelo.md)) aprovado;
- [ ] revisão do Guardião (APROVADO) e do advogado nos itens ⚖️.

## 6. Pontos para o advogado ⚖️

1. Data exata de vigência (26/08 ou setembro de 2026).
2. Se a clínica que apenas contrata nossa IA precisa da Comissão de IA e Telemedicina (art. 14, par. único fala em "sistemas próprios").
3. A classificação de risco proposta (§4), sobretudo o escriba como médio.
4. Se aplicar o padrão CFM a fisio, psico e nutrição cria alguma obrigação perante os outros conselhos.
5. Relação com a ANVISA (RDC 657/2022) para a sugestão de CID.

## 7. Fontes (consultadas em 10/10/2026)

- **Texto oficial:** Res. CFM 2.454/2026 (PDF do CFM, com retificação): <https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2026/2454_2026.pdf>
- Notícia oficial do CFM: <https://portal.cfm.org.br/noticias/cfm-normatiza-uso-da-ia-na-medicina/>
- Análise (Cescon Barrieu): <https://cesconbarrieu.com.br/resolucao-cfm-no-2-454-2026-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/>
- Análise (Machado Meyer): <https://www.machadomeyer.com.br/pt/inteligencia-juridica/publicacoes-ij/life-sciences-e-saude/cfm-regulamenta-o-uso-de-inteligencia-artificial-na-medicina>
- Res. CFM 2.336/2023 (publicidade médica): <https://sistemas.cfm.org.br/normas/visualizar/resolucoes/BR/2023/2336>
