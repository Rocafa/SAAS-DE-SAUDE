# Log noturno: 10 para 11/11/2026

> Maestro, trabalhando sozinho enquanto os sócios dormem. Branch `eng/better-auth-fila-noturna`, sobre o #176. Cada entrada traz o horário (UTC-3), o que foi feito e o resultado. Regras seguidas: sem merge sem a aprovação do outro sócio, sem `--admin`, sem mexer nas configurações do repositório nem da conta, e o Guardião revisa antes de pedir a revisão do sócio.

## Plano da noite

1. **G3 completa:** a anonimização zera o HMAC dos convites aceitos pela conta em **todas** as clínicas, não só nas que têm vínculo e na de origem.
2. **R4 do 3a:** teste pela HTTP de que a resposta leva só o `Set-Cookie` da sessão.
3. **Marca de reuso no login** gravada antes da conferência: estudar se dá para mover sem abrir corrida.
4. Conferir as aprovações do @Lopesloro e mesclar o que estiver aprovado (sem `--delete-branch` quando houver PR em cima).
5. Abrir o PR, passar pelo Guardião, corrigir o que ele apontar e atualizar este log.

## Entradas
- **G3 completa:** a anonimização passa por todas as clínicas pela lista do agendador. Teste na bancada com um convite aceito numa clínica de onde a pessoa já saiu.
- **R4 do 3a:** teste HTTP com o `SessaoGuard` real, cobrindo a rota comum (um `Set-Cookie`, só o da sessão, com os atributos) e a rota de polling (nenhum `Set-Cookie`).
- **Marca de reuso no login:** analisei e mantive a ordem atual (arquitetura §14.8). Mudar abriria a corrida do código repetido.
- Verificação local: `tsc`, `eslint` e 1133 testes de unidade passando. A bancada RLS roda no CI.
- **Guardião vetou o #177 (V1):** o `withTenant` recusa o `USUARIO_SISTEMA`, então o laço novo nunca rodava. O CI confirmou, com falha no RLS. Corrigido com o usuário de sistema dos jobs, mais o evento por clínica que falha, a trilha com ator sistema, a lista compartilhada e as notas na arquitetura (V2 e V3).
- **Reconferência do #177:** aprovado, valendo com o CI verde. Corrigi R1 (comentário do `withTenant` fora do lugar) e R2 (alarme por clínica limitado a um por minuto).
