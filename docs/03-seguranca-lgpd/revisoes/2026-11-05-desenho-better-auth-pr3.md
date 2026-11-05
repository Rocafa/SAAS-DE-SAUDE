# Parecer do Guardião LGPD: desenho do PR 3 da autenticação real (D4, Better Auth, §14)

> Data: 05/11/2026. Branch: `eng/better-auth-equipe` (`989c302`), §14 de `docs/04-arquitetura/autenticacao-better-auth.md`. Base: parecer do desenho (R16 a R20), pareceres do código do #149 e do #152 (pendências "antes do PR 3": R3 a R9 do #152) e a política de MFA (`2026-11-03-mfa-politica.md`). Revisão do desenho, antes de existir código.

## Veredito

| Parte | Veredito |
|---|---|
| **3a: sessão e clínica** | **APROVADO COM RESSALVAS** (R3 a R7). Pode ir para o código. |
| **3b: equipe** | **VETADO no desenho até resolver a R1 e a R2.** Depois disso, APROVADO COM RESSALVAS (R8 a R11). |
| **3c: produção** | **APROVADO COM RESSALVAS** (R12 a R14). A abertura depende do parecer final do Guardião sobre o 3c. |

A divisão em três PRs e a regra de que a produção só abre no 3c estão corretas. A 3a resolve bem as pendências do #149 e do #152. Ela segue a proposta da R7 do #152 para o MFA sem clínica (5 min, só a **primeira** escolha, perfis da clínica escolhida). A lista de sessões vem sem IP nem user-agent (R20), e o polling não renova a sessão (R19).

O veto da 3b vem de um problema de fundo. Sem provedor de e-mail, **o admin vê o token** do convite e da recuperação. Do jeito que está escrito, quem tem o token define a senha **e** cadastra o fator. Então o admin pode se passar pela pessoa. Pior: se a pessoa trabalha em outra clínica, o admin de uma clínica toma uma credencial que abre **a outra**. Isso quebra o isolamento entre clínicas, que é a regra 1 da plataforma. A R17 pedia exatamente que o admin "nunca defina a senha" nem "entre como o usuário". Esconder a senha do admin não basta: o token tem o mesmo poder.

## Ressalvas

### 3b: bloqueia o código da 3b até estar no desenho

1. **Nenhum token sozinho restaura os dois fatores.**
   - **Recuperação do tipo `senha`:** o token define a senha nova, mas o TOTP atual da pessoa continua. O primeiro login pede o código, e o admin não o tem.
   - **Recuperação do tipo `fator`:** o token permite cadastrar um TOTP novo só depois de a pessoa provar a **senha atual** no fluxo. O admin não a tem.
   - **Perdeu os dois:** não é ação do admin de uma clínica sozinho. Ou é ação do suporte da plataforma, com conferência de identidade registrada (procedimento escrito, trilha `support_*`), ou, para quem tem vínculo em uma clínica só, do admin dessa clínica com os efeitos do item 2.
   - **Desbloqueio do login (R4 do #152):** **não** é recuperação de senha. É uma ação própria que só zera os contadores (`bl:v1:login:<hmac>`), com justificativa e trilha. Forçar a troca de senha por causa de um bloqueio causado por um terceiro não faz sentido.
   - **Teste:** com o token do tipo `senha`, o login de quem já tem TOTP continua pedindo o código; com o token do tipo `fator` sem a senha atual, o cadastro é recusado.
2. **O efeito entre clínicas fica preso à clínica de quem agiu.** Toda recuperação que restaurar fator (o caso de "perdeu os dois") e todo **convite de conta nova** são atos de **uma** clínica. Se a pessoa tiver vínculo em outras clínicas, esses vínculos ficam **suspensos** (o provedor devolve `null` nessas clínicas) até um admin de **cada** uma delas confirmar, com aviso a esses admins. O aviso e a trilha que o desenho prevê só detectam o problema depois; aqui é preciso impedir.
   - **Convite de conta nova:** o vínculo em `clinic_members` só nasce no **aceite**, não no convite. Até lá, o convite vive numa tabela própria (`convite`: hash do token, clínica, e-mail informado pelo admin, perfil, prazo). Hoje o desenho concede o perfil já no convite. Isso cria vínculo sem o aceite da pessoa e, numa conta que já existe, faz aparecer na lista de membros da clínica B o nome que a pessoa cadastrou na clínica A. A "resposta idêntica" deixa de esconder se a conta existe.
   - **Na clínica, antes do aceite:** só aparece o que o próprio admin digitou (e-mail e perfil), com a situação `pendente`. Nunca um dado de `identidade.usuario`.

### 3a

3. **`SessaoDePessoaGuard` com as mesmas travas do provedor.**
   - Valem o absoluto de 12 h, a inatividade, a conta ativa e o `cadastro_do_fator_pendente`.
   - A sessão pendente **só** acessa as rotas do cadastro do fator, e isso vale para qualquer guard e para a montagem. Uma lista fechada de rotas por estado da sessão, com teste.
   - `GET /sessao/clinicas` lê o nome da clínica por uma função que recebe **só** o `userId` da sessão (nunca do cliente) e devolve só id e nome de clínica **ativa** com vínculo **ativo**.
4. **Conversão do MFA sem clínica.** `mfa_sem_clinica_em` é **consumido** (zerado) na conversão e em qualquer troca, logout ou expiração. Ele nunca é lido como `mfa_em` pelo `resolver`, e o `input: false` e o `returned: false` continuam valendo como nos outros campos. Teste: escolher a clínica A dentro de 5 min marca o MFA; trocar para B zera; escolher A depois de 5 min não marca.
5. **`Set-Cookie` renovado só por lista fechada.** O guard aplica **apenas** o `Set-Cookie` do cookie de sessão que veio da biblioteca, com os atributos já testados no PR 1 (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`). Nenhum outro cabeçalho da biblioteca chega à resposta da rota de negócio. Nas rotas `@SemRenovarSessao()`, nenhum `Set-Cookie` sai.
6. **Sessões.** No `DELETE /sessao/sessoes/:id`, o id é opaco e só casa com sessões da própria pessoa: a comparação é feita no banco com `user_id` da sessão, nunca só pelos 8 hex. `encerrar-todas` não pede MFA (encerrar sessões só protege). Na trilha das clínicas vai só `op: logout_global`.
7. **Expurgo.** Inclui também o cadastro do TOTP iniciado e não concluído (`dois_fatores.verificado = false` há mais de 24 h), porque é segredo guardado sem uso, e os convites e tokens de recuperação vencidos ou usados (3b). O expurgo guarda só as contagens. Entra na matriz de retenção.

### 3b, depois do veto resolvido

8. **Sessão `cadastro_do_fator_pendente`:** vale no máximo 15 min, não serve para a escolha de clínica nem para nenhuma rota de negócio, e cai na conclusão do cadastro (sessão nova, como a biblioteca já faz).
9. **Aceite e convite com limite.**
   - `POST /convites/aceitar` com conta existente confere a senha atual e **conta no bloqueio de login** (`login:<email>` e origem). Sem isso, vira um caminho de tentativa de senha fora do bloqueio.
   - Convites por admin com teto diário e alerta de volume, para que a resposta idêntica não vire ferramenta de varredura.
   - Uma conta existente nunca recebe senha nem fator pelo convite (o desenho já diz isso; manter com teste).
10. **Desligamento por trigger.** A função do trigger de espelho (SECURITY DEFINER, 0064) ganha só o `DELETE FROM identidade.sessao WHERE usuario_id = $1 AND clinica_ativa = $2`, com `search_path` fixo e sem parâmetro vindo de fora do `NEW`/`OLD`. Teste RLS: revogar o último perfil derruba a sessão naquela clínica e não toca a sessão em outra.
11. **R18, anonimização e minimização.** Manter `identidade.usuario` pelo id e anonimizar e-mail e nome está certo. A identificação do autor (nome e registro) fica em `professionals` da clínica, com a retenção do prontuário: 20 anos, CFM 1.821/2007 e LGPD art. 16, I.
    - **Na anonimização (ou depois de N dias com a conta inativa, a definir no RIPD):** apagar também a **credencial**, ou seja, o hash da senha (`conta`), o TOTP (`dois_fatores`), as sessões, as verificações e os convites. Credencial de quem saiu não tem base legal para ficar guardada.
    - **Reativação por convite** depois disso é cadastro do zero.

### 3c

12. **Trânsito e segredos.**
    - `DATABASE_AUTH_URL` e `DATABASE_URL` com TLS verificado (`sslmode=verify-full`).
    - Redis do bloqueio com TLS e autenticação.
    - `RATE_LIMIT_HASH_KEY` também no Secrets Manager.
    - Os segredos versionados testados em staging: um fator cifrado com a versão 1 continua sendo conferido depois que a versão 2 vira a atual, e a versão 1 só sai depois do recadastro ou da recifra.
    - Runbook de rotação escrito.
13. **Portão de abertura.** Incluir `production` em `AMBIENTES_POR_TIPO['better-auth']` só depois de um checklist assinado que liste todas as pendências "antes do PR 3" (#149: RIPD, retenção, segredos, `Set-Cookie`; #152: R3 a R9) com o PR de cada uma, e do parecer final do Guardião sobre o 3c. O teste de fumaça no staging usa **só contas fictícias** e confere também o bloqueio por origem atrás do ALB (`HTTP_TRUST_PROXY_HOPS`).
14. **RIPD e contratos.**
    - O RIPD ganha o schema `identidade`, o prefixo do SHA-1 (não é dado pessoal), os contadores em HMAC, a anonimização (R18) e o fato de que, sem provedor de e-mail, o e-mail da conta **não é verificado**: ele é declarado pelo admin.
    - O contrato com a clínica (operador) passa a dizer que o admin dela entrega convites e recuperações fora da plataforma e responde por essa entrega.

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal | Contas, vínculos e credenciais da equipe: execução do contrato e segurança (art. 7º V e IX, art. 46). Justificativas da recuperação só na trilha: prestação de contas (art. 6º X). Não há dado de saúde. ✅ |
| Isolamento | A escolha de clínica passa pelo espelho e devolve 404 sem vínculo. A trilha vai para a clínica escolhida. A lista de sessões não mostra clínica. ✅ (o efeito entre clínicas da 3b está na R1 e na R2) |
| Minimização | Lista de sessões sem IP nem user-agent. Expurgo só com contagens. Justificativa fora do log técnico. Tokens só em SHA-256. ✅ |
| Respostas idênticas | Mesmo erro para token inválido, vencido ou usado; 404 em vez de 403 para clínica sem vínculo. ✅ (a resposta idêntica do convite depende da R2) |
| R16, R17, R19 e R20 | Endereçadas, com as correções acima. ✅ |
| Dados reais | Desenho sem nenhum. ✅ |
| CFM, ANS e ICP-Brasil | R18 resolvida pela tabela da clínica, com a retenção de 20 anos. MFA real em produção atende ao NGS2. Não toca TISS nem assinatura. ✅ |
