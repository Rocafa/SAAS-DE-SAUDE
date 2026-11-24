# CRM — base visual e Pacientes

## Objetivo

Criar a base reutilizável de gestão do front e aplicá-la em Pacientes. A interface deve ser calma, consistente e previsível: títulos curtos, ações principais no mesmo lugar, listas claras e estados de carregamento, vazio e erro sempre explícitos.

## Escopo

Somente `apps/web`, usando o adaptador fake. Não há mudanças de API, banco, permissões, regras de negócio, dependências ou textos de marketing.

Entregas:

- `CabecalhoPagina`, `TabelaRegistros`, `FichaRegistro`, `LinhaDoTempo` e `SeloStatus` em `components/crm/`.
- Lista de Pacientes com busca, filtro por situação, ordenação e paginação.
- Ficha com cabeçalho, metadados, ações e quatro abas com URL própria: Visão geral, Agenda, Financeiro e Documentos.
- Linha do tempo com data, tipo e autor/origem, sem conteúdo clínico.
- Tabela no computador e cartões no celular.
- Testes unitários de lógica e HTML estático, além de Playwright para comportamento real.

## Decisões de desenho

- A Visão geral conserva o conteúdo atual da ficha. As demais abas isolam suas seções. Isso evita quebrar os roteiros existentes do Ajudante e mantém os testes de permissão inalterados.
- A lista continua escondendo inativos por padrão. O filtro permite ver inativos ou todos.
- A busca fake continua usando `acharPacientes`, inclusive nome social, telefone e final do CPF. No modo HTTP, a busca de servidor e sua auditoria continuam intactas.
- A paginação é local, com 10 registros por página. Busca e filtro voltam à primeira página; páginas fora do intervalo são corrigidas sem apagar dados.
- As abas usam links com `?aba=...`: são navegação real, funcionam com Enter, voltar/avançar do navegador e URL compartilhável.
- A navegação principal já tem barra lateral fixa, `aria-current` e versão móvel. Ela será preservada e coberta por testes, não reescrita.
- Componentes reutilizam `Botao`, `Carregando`, `Vazio`, `Erro` e `Status`; nenhum estado ou estilo de status é duplicado sem necessidade.

## Restrições

- Apenas tokens existentes de `globals.css`; sem cores novas ou azul.
- Contraste AA, foco visível, alvo mínimo de 48 px e modo escuro continuam obrigatórios.
- Recepção não ganha acesso a prontuário nem a nomes de anexos clínicos.
- Nenhum dado real, segredo, conteúdo clínico ou termo de busca em logs.
- Comentários de regra, decisões do Guardião e avisos de retenção são preservados.
- Tipagem sempre explícita e estrita, sem suprimir verificações de TypeScript ou ESLint; nenhum teste pulado ou dependência nova.

## Fora do escopo — parte 2

Agenda, Atendimento, Financeiro, Documentos e Configurações.
