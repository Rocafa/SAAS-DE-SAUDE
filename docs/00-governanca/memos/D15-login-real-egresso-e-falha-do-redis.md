# D15 — Login real: saída para a base de senhas vazadas (B2) e o que fazer quando o Redis cai
> Memorando para decisão dos sócios (N0) · 10/11/2026 · preparado pelo Maestro com o Guardião · **Este memo não decide nada.**
> Origem: checklist da abertura do login real (`docs/03-seguranca-lgpd/prontidao-producao.md`, item B2) e a reconferência do #176 (H1).

**Perguntas:**
1. A API pode consultar a base pública de senhas vazadas na internet, ou o login abre sem essa conferência?
2. Quando o Redis (o contador do bloqueio) cai, o login com TOTP continua funcionando sem trava, ou para?

**Prazo sugerido:** antes de ligar `login_real_habilitado` no staging · **Urgência:** Alta (trava a abertura do login real)

## 1. Saída para a base de senhas vazadas (B2)

**Contexto.** Na troca e na criação de senha, a API manda os 5 primeiros caracteres do SHA-1 da senha para `api.pwnedpasswords.com` (k-anonimato: a senha nunca sai). Só que a API **não tem saída para a internet**: o grupo de segurança só libera os endpoints internos da AWS. Hoje a conferência falha, a troca segue e sai o alarme `CONFERENCIA_DE_SENHA_INDISPONIVEL`. Na prática a conferência não existe.

| Opção | Prós | Contras |
|---|---|---|
| A. Filtro de saída por domínio na AWS (ex.: Network Firewall), liberando só `api.pwnedpasswords.com:443` | A conferência funciona e o resto continua fechado | Custo fixo mensal a mais; mais uma peça para operar. Custo a confirmar na AWS Pricing Calculator |
| B. Proxy de saída próprio (instância pequena com lista de domínios) | Barato | Mais uma máquina para manter e atualizar; vira ponto único de falha da conferência |
| C. Cópia local da base (download periódico das listas de hashes) | Nenhuma saída da API; conferência mesmo com a internet fora | Base grande para guardar e atualizar; job novo |
| D. Abrir sem a conferência, por decisão escrita | Nenhum custo; nada a construir | Senha já vazada pode ser aceita. O TOTP obrigatório, o bloqueio 5/15 e o mínimo de 12 caracteres reduzem o risco, mas não o eliminam |

**Recomendação dos agentes:** recomendação, não decisão. **D no piloto**, com a decisão escrita aqui e no RIPD, porque o TOTP é obrigatório para toda a equipe. **A ou C antes da venda aberta (GA)**, revistas junto com o orçamento da D13.

## 2. Quando o Redis cai

**Contexto.** O Redis guarda os contadores do bloqueio de 5 falhas em 15 minutos e a marca que impede usar o mesmo código TOTP duas vezes. Hoje:

- **Login e código do login:** se o Redis cai, **o login continua** sem bloqueio e sem a trava do código repetido. Sai o alarme imediato `RATE_LIMIT_FAIL_OPEN`.
- **Recuperação pelo admin e aceite de convite:** **param** (falha fechada, 503), com `BLOQUEIO_INDISPONIVEL`.

| Opção | Prós | Contras |
|---|---|---|
| A. Manter como está (login abre; recuperação e aceite fecham) | Ninguém da clínica fica sem entrar numa queda do Redis | Durante a queda, quem já tem a senha pode tentar códigos sem limite (ataque precisa de senha certa e acontece só enquanto o Redis está fora, com alarme) |
| B. Fechar também o login | Nenhuma tentativa sem limite | Queda do Redis = **ninguém entra**, e a agenda e o prontuário param |
| C. Contador de reserva no Postgres quando o Redis cai | Mantém o limite e o login | Mais código e mais carga no banco justamente durante um incidente |

**Recomendação dos agentes:** recomendação, não decisão. **A**, com o Redis em Multi-AZ na produção e o alarme imediato ligado ao plantão. **C** pode entrar depois do piloto se as quedas acontecerem na prática.

## O que trava se adiar

O item B2 do checklist e o parecer final do Guardião para ligar o login real (`login_real_habilitado`). Sem eles, o staging continua com a sessão fictícia.

## Para decidir, falta

O orçamento da D13 (para as opções 1A e 1C) e a confirmação de que o Redis da produção sobe em Multi-AZ.

## Onde está

- `docs/03-seguranca-lgpd/prontidao-producao.md` (B2) e `RIPD-identidade.md` §8
- `docs/04-arquitetura/autenticacao-better-auth.md` §13 (senha vazada) e §14.7 (falha do contador)
- Pareceres: `docs/03-seguranca-lgpd/revisoes/2026-11-05-codigo-better-auth-pr2.md` (R5) e `2026-11-10-codigo-better-auth-fila-antiga.md` (H1)

## Votos (registro)

| Sócio | Pergunta 1 (senha vazada) | Pergunta 2 (Redis caído) | Data |
|---|---|---|---|
| @Rocafa | **D**: abrir o piloto sem a conferência, com a decisão escrita aqui e no RIPD; A ou C antes da venda aberta | sem preferência | 12/11/2026 |
| @Lopesloro | — | — | — |

Vira decisão com o voto do outro sócio. Na pergunta 2, se o @Lopesloro votar, vale o voto dele; se não votar, fica o que já está no código (opção A).
