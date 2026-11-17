# Pacote para a revisão externa (pentest e auditoria LGPD)

> Para contratar uma empresa ou um profissional independente. Preparado em 04/11/2026. Uma revisão externa só tem valor se for feita por gente de fora: este documento define o escopo e o que entregar, mas **não substitui** a revisão.

## 1. Quando

Depois de três condições:
1. **D4 confirmada e login real ligado:** sem isso, o pentest testaria uma sessão de mentira.
2. **Staging na AWS:** igual à produção, com dados 100% fictícios.
3. **Bloqueios internos fechados:** ver [prontidao-producao.md](prontidao-producao.md). Pagar para achar o que já sabemos é desperdício.

## 2. Escopo, separado por público e por canal

| Frente | Paciente (cliente) | Profissional (equipe da clínica) |
|---|---|---|
| **Site** (navegador desktop e celular) | Portal `/portal`: convite, código por SMS, vínculos, consultas, documentos, direitos do titular (art. 18), responsável por menor | Telas da equipe: agenda, pacientes, prontuário (com psicologia), financeiro, guias, mensagens, configurações, membros, exportação |
| **App** (PWA instalado no Android e no iOS) | Manifesto do portal, service worker, cache offline, deep links, aparelho compartilhado | Manifesto da equipe, cache offline, sessão em aparelho da clínica |
| **API** | Rotas `/portal/*` | Todas as demais rotas, inclusive suporte e webhooks |
| **Roteiro detalhado** | 25 testes em [revisao-interna-pacientes §Itens para a revisão EXTERNA](revisoes/2026-11-04-revisao-interna-pacientes.md) | Roteiro em [revisao-interna-profissionais §Itens para a revisão EXTERNA](revisoes/2026-11-04-revisao-interna-profissionais.md) |

Fora do escopo: a infraestrutura da AWS em si, que fica para uma revisão de nuvem própria, e engenharia social.

## 3. Métodos exigidos

- **OWASP WSTG** (caixa-preta e caixa-cinza) e verificação **OWASP ASVS 4.0 nível 2**.
- **OWASP MASVS** nas partes que se aplicam ao PWA: armazenamento local, cache, deep links e aparelho compartilhado.
- **Isolamento entre clínicas:** com contas de duas clínicas fictícias, tentar ler e escrever dado da outra por todas as rotas, trocando ids e cabeçalhos.
- **Perfis:** recepção, financeiro, profissional e admin. Cada um tenta o que não pode, inclusive o prontuário de psicologia de outro profissional.
- **Logs e trilha:** confirmar que cada ataque deixou rastro (ver [logs-de-seguranca.md](logs-de-seguranca.md)) e que nenhum log ou mensagem de erro mostra dado pessoal.
- **Auditoria LGPD documental:** RIPDs, bases legais, matriz de retenção, plano de incidentes, contrato com operadores (DPA) e direitos do titular, contra a prática observada.

## 4. Regras de engajamento

- Só em staging, com dados fictícios fornecidos por nós. **Nunca** em produção nem com dado real.
- Janela combinada, IPs de origem informados e contato de plantão dos dois lados.
- Achado crítico (vazamento entre clínicas ou acesso a prontuário): parar e avisar na hora.
- Termo de confidencialidade. Os relatórios ficam fora do repositório público.

## 5. Entregáveis

1. Relatório com cada achado: severidade (CVSS 3.1), passos para reproduzir, evidência e correção.
2. Resumo executivo, separado para paciente e para profissional.
3. **Reteste** depois das correções, incluído no preço.
4. Carta de atestado com escopo, datas e commit testado, para mostrar a clínicas e investidores.

## 6. Critério para produção

Nenhum achado crítico ou alto em aberto. Os médios precisam ter plano com data. O resultado entra em [prontidao-producao.md](prontidao-producao.md) antes da assinatura dos sócios.
