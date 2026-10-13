# Estado da frente FRONT (rodada 8)

> Atualizado: 12/10/2026 · Ordem: ORDEM-001 (todas as telas + o Ajudante) · Branch do PR 1: `front/design-system-e-ajudante`

## Plano de entrega (PRs pequenos, na ordem)

| PR | Escopo | Estado |
|---|---|---|
| 1 | Design system em cinza + estrutura (menu lateral e barra inferior) + camada de dados fake + **Ajudante completo** + Início | 🟢 aberto, pede revisão do Guardião |
| 2 | Agenda (dia, semana, profissional, encaixe, arrastar, recorrência, espera, check-in, simultâneo) + Pacientes (cadastro, ficha completa, linha do tempo, anexos, inativar) | 🟢 aberto, empilhado sobre o PR 1 |
| 3 | Atendimento/Prontuário + Documentos | 🟢 aberto, empilhado sobre o PR 2 |
| 4 | Financeiro + Guias + Mensagens + Relatórios | 🟢 aberto, empilhado sobre o PR 3 |
| 5 | Configurações (LGPD e assinatura) + Primeiros passos + Ajuda + Acesso | ⬜ |
| 6 | Portal do paciente + PWA + páginas de erro | ⬜ |

## O que o PR 1 entrega

- **Design system em cinza.** A paleta padrão do Tailwind foi apagada (`--color-*: initial`): `bg-blue-500` nem existe. Tokens em CSS (`app/globals.css`) para claro e escuro; contraste do texto ≥ 7:1 conferido em teste; foco preto de 3 px com halo branco; letra base de 18 px; alvos de 48 px ou mais. Fonte Atkinson Hyperlegible (feita para baixa visão), servida da própria origem por `next/font`.
- **Três travas contra cor:** teste Vitest nos tokens e no código, `scripts/checar-cinza.mjs` no `pnpm build` (lê o CSS final e reprova qualquer cor com matiz; testado injetando um azul) e Playwright lendo as cores **calculadas** de todos os elementos de cada tela.
- **Estrutura:** menu lateral com 6 itens no computador; barra inferior com 4 itens + "Mais" no celular. Ícone sempre com texto.
- **Camada de dados:** `lib/api` com interface `ApiClinica` e adaptador fake em memória (30 pacientes inventados, marcados como fictícios; CPFs começam com 000). `?demo=erro|vazio|lento` mostra os estados de tela.
- **Telas:** Hoje (próximos, quem chegou, falta confirmar, pendências, faltas, botão grande "Marcar consulta"); Marcar consulta (3 campos, serve também para remarcar e encaixe); Agenda do dia; Pacientes; Ficha (nome social em destaque, responsáveis, próximas consultas com remarcar/cancelar, recibos); Mais; aviso "chega no próximo pacote" para as demais rotas.
- **Ajudante:** botão grande no canto, Ctrl/Cmd+K e "/". Busca sem acento, sem maiúscula e com erro de digitação, por nome, nome social, telefone e fim do CPF; pacientes, agenda, páginas, configurações, ações e artigos de ajuda, agrupados, com setas e Enter. Ações em pt-BR por regras locais (`IntentParser`, pronto para plugar um LLM no Brasil na D3). "Fazer por mim" (cursor visível e narração) e "Me mostra como" (destaque passo a passo). Para no botão de confirmar; "Desfazer" no fim.
- **Privacidade:** o texto do Ajudante não vai para console, log, armazenamento, rede nem analytics (teste varre o código; E2E confere o console). Voz desligada (a API do Chrome manda áudio ao Google); interface `ReconhecimentoVozLocal` pronta.

## Números

- Vitest: 137 testes no web (69 frases do interpretador em pt-BR, busca, registro de ações, privacidade, cores e contraste, e os 5 de cabeçalhos de segurança, que continuam verdes).
- Playwright: 48 testes (24 em 375 px e 24 em 1280 px): "achar paciente pelo Ajudante", "marcar consulta pelo Ajudante até o botão de confirmar", axe sem violação séria em todas as telas, cinza renderizado, estados de carregando/vazio/erro/sem internet.
- Capturas: `docs/02-produto/telas/` (celular e computador, claro e escuro).

## Dependências novas (só `apps/web`)

`cmdk` (paleta do Ajudante), `@radix-ui/react-dialog`, `@radix-ui/react-slot`, `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`; dev: `@playwright/test`, `@axe-core/playwright`. Todas da lista permitida na ordem.

## Pendências e perguntas ao Maestro

- O E2E (Playwright) ainda não roda no CI: pede um job novo em `.github/workflows/ci.yml`, que é caminho da DevOps. Sugestão: `pnpm --filter @plataforma/web build && pnpm --filter @plataforma/web exec playwright install --with-deps chromium && pnpm --filter @plataforma/web test:e2e`.
- O build agora baixa a fonte do Google **na hora do build** (não no navegador). Se o CI não tiver saída para a internet, trocar por arquivo de fonte versionado com `next/font/local`.

## O que o PR 2 entrega

- **Agenda** em 4 jeitos de ver: Dia (agrupado por horário, com Chegou, Atender, Faltou, Remarcar e Cancelar com confirmação), Semana (remarcar **arrastando** no computador ou pelo botão "Remarcar" em qualquer tela), Por profissional e Lista de espera (colocar, tirar com desfazer, "Marcar horário" já com o paciente).
- **Marcar**: horário ocupado é recusado com instrução ("Escolha outro horário ou faça um encaixe"); encaixe passa por cima; sessões recorrentes (toda semana ou a cada 2 semanas, 2 a 52 vezes) e pacote com saldo; desfazer apaga a série inteira.
- **Atendimento simultâneo** (fisio no ginásio): o profissional tem limite de pacientes ao mesmo tempo; a agenda mostra "2 pacientes ao mesmo tempo".
- **Pacientes**: cadastro com só nome e telefone obrigatórios, nome social, CPF opcional com dígito verificador, responsável obrigatório para menor; ficha com pacotes (saldo), anexos, linha do tempo e **inativar sem apagar** (texto explica a guarda legal; consultas futuras canceladas; desfazer reativa). Inativos ficam escondidos na lista, com opção de mostrar.
- Números do PR 2: Vitest 153 no web; Playwright 75 verdes + 1 pulado de propósito (arrastar no celular; lá o caminho é o botão, testado).

## O que o PR 3 entrega

- **Atendimento:** lista do dia do profissional que está usando; tela com evolução pelo modelo do nicho (fisioterapia, terapia ocupacional, psicologia), rascunho salvo sozinho, histórico, "Assinar" com confirmação ("depois de assinada não muda; correção vira adendo") e adendo. Só o profissional do atendimento escreve e assina.
- **Psicologia em compartimento sigiloso:** separado e marcado na ficha, no prontuário e no histórico; quem não é o autor vê só que o registro existe (o fake nem devolve o conteúdo).
- **Escriba de IA:** só o aviso, botão desligado ("em breve, com revisão humana").
- **Documentos:** atestado (1 a 15 dias por extenso; CID só com autorização do paciente), declaração de comparecimento e recibo, com prévia em folha e "Imprimir" (a impressão sai só com a folha). ICP-Brasil marcado como "em breve".
- **Demonstração:** em Mais › "Demonstração: entrar como", troca entre recepção, fisioterapeuta e psicólogo para ver as permissões.
- Números do PR 3: Vitest 163 no web; Playwright 93 verdes + 1 pulado de propósito.

## O que o PR 4 entrega

- **Financeiro:** recebido hoje (total e por forma), contas a receber com "Receber" (dinheiro, cartão ou Pix) e desfazer, pacotes e saldo, todos os recibos com "Imprimir". Pix com QR e baixa automática marcado como "em breve" (D5).
- **Guias de convênio** (controle simples do M1, sem TISS): cadastro com erros que dizem o que fazer; avisos "vence em X dias", "só resta 1 sessão", "guia vencida".
- **Mensagens:** prévia da caixa do WhatsApp (M2) com conversas fictícias; nada é enviado; campo de resposta desligado.
- **Relatórios:** atendimentos, faltas, taxa de faltas e recebido em 7 dias, 30 dias ou no mês; gráfico em cinza (atendidos em preto, faltas listradas) e a mesma informação em tabela.
- Números do PR 4: Vitest 172 no web; Playwright 117 verdes + 1 pulado de propósito.
