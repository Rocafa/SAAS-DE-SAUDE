# Parecer do Guardião: desenho do provisionamento da clínica e primeiro fator do fundador (B11)

> 16/11/2026 · Guardião LGPD & Segurança · parecer de **desenho** (sem código), branch `eng/hmac-por-uso`.
> Objeto: [`docs/04-arquitetura/provisionamento-da-clinica.md`](../../04-arquitetura/provisionamento-da-clinica.md).
> Base: B11 de [`prontidao-producao.md`](../prontidao-producao.md); parecer do #182 ([`2026-11-16-codigo-181-182-do-socio.md`](2026-11-16-codigo-181-182-do-socio.md)); padrão do B10 ([`anonimizacao-pelo-suporte.md`](../../04-arquitetura/anonimizacao-pelo-suporte.md) e [parecer de 12/11](2026-11-12-desenho-anonimizacao-pelo-suporte.md)); código: `membros.ts` (`criarClinica`), `convites.ts` (`aceitar`), `credenciais.ts` e `provedor.ts` (`usarRecuperacao`), `db/identidade.ts`; [`RIPD-identidade.md`](../RIPD-identidade.md).

## Veredito: **APROVADO COM RESSALVAS**

O rumo está certo e a R8 fica intacta: o fundador só cadastra o fator numa sessão de cadastro pendente aberta por um token de uso único, e o teste R8 (`contrato-provedor-better-auth.rls.test.ts:715`) não muda. O desenho **não vira código como está**. Ele (a) cria uma porta nova na API para a nossa equipe, sem modelo de identidade de plataforma, o que o B10 já recusou (P1); (b) guarda o e-mail do fundador em claro recuperável quando só precisa do HMAC, como o convite (R1); (c) cria a conta em `identidade.usuario` antes da ativação, o que obriga a ter nome e e-mail na tarefa e ignora o fundador que já tem conta (R2); (d) é incoerente na entrega do token: guarda só o hash e depois "mostra o link uma vez" (R3); (e) responde 410 ao token vencido ou usado, o que vira oráculo (R4); (f) não diz como provar quem provisionou, e a trilha da clínica sairia com o fundador como ator de um ato da nossa equipe (R7). As ressalvas R1 a R10 são condição para o PR de código.

## Conferência no código

- `criarClinica` (`membros.ts:106`) só é citada no próprio arquivo e nos testes. Não há rota, comando nem job. Ela roda `db.run(clinicaId, ..., fundadorUserId)`, então o usuário da transação **é o fundador**: `tenant_create` e `member_found` saem com `actor_id = fundador`. Se a nossa equipe chama a função, a trilha atribui ao fundador um ato que ele não fez. É o mesmo defeito da R1 do B10.
- O convite (`convites.ts:83`) guarda **só** o SHA-256 do token e o **HMAC** do e-mail. O aceite confere o e-mail digitado contra o HMAC, cria a conta por último e trata a conta já existente com login completo (senha e TOTP). Tudo o que não confere (token inválido, vencido, usado, revogado, e-mail diferente ou admin que saiu) responde com o **mesmo 404**. O teto diário vale por admin.
- A recuperação (`provedor.ts`, `usarRecuperacao`) só aceita o token **com** uma credencial que a pessoa já tem (senha para o fator, TOTP para a senha). Ela tem contador por pessoa e por origem, falha fechada com `BLOQUEIO_INDISPONIVEL` e o mesmo erro para senha errada ou bloqueio. **O fundador não tem credencial nenhuma.** Na ativação, o token é a única coisa que ele traz. Por isso a ativação precisa de mais que "rate limit como `/recuperacao/usar`" (R4).
- `identidade.usuario` tem `nome` e `email` como `notNull` e `ativo` com padrão `true`. Criar a conta no provisionamento obriga a ter o nome e o e-mail em claro dentro da tarefa e deixa uma conta **ativa** sem senha até a ativação.
- A conferência de senha vazada (`conferirSenhaVazada`) falha **aberta** e registra `CONFERENCIA_DE_SENHA_INDISPONIVEL`. Essa é a opção D do D15, que ainda espera o voto do segundo sócio (B2).

## Respostas às perguntas

**1. Rota interna de plataforma ou outra entrada para o e-mail? Decisão: nenhuma rota. O e-mail entra pela tarefa do ECS, por parâmetro cifrado, e a tarefa guarda só o HMAC.**
- Hoje a API não tem identidade de plataforma. Toda conta em `identidade` é de pessoa de clínica, e o MFA da sessão é de clínica. Uma "rota interna com MFA" pede um modelo novo de autenticação, de perfil e de trilha para a nossa equipe, que é superfície permanente na API pública para uma operação rara. Foi o motivo da P1 do B10.
- Caminho: o operador cria um parâmetro `SecureString` no SSM (`/provisionamento/<pedido-uuid>`, chave KMS própria) com o e-mail do fundador e o nome da clínica, conferidos contra o contrato assinado. A tarefa recebe só `--pedido <uuid>`, lê o parâmetro, calcula o HMAC do e-mail (derivação própria por uso, por exemplo `provisionamento-email`, no padrão do `eng/hmac-por-uso`) e **apaga o parâmetro** antes de sair, com sucesso ou falha. No CloudTrail ficam só o nome do parâmetro e o uuid.
- A tabela `pedido_de_provisionamento` com o e-mail cifrado sai do desenho. O registro passa a ser a própria linha de ativação (R1). O "pedido" de verdade, com o contato do fundador, é o contrato, que vive fora do sistema e tem retenção própria.
- O nome da clínica pode ser dado pessoal (consultório individual com o nome do profissional). Ele vai pelo mesmo parâmetro, nunca como argumento da tarefa.

**2. 72 h e uso único? Aviso quando vencer? Decisão: 72 h e uso único, aceitos com condições. Aviso, sim.**
- As 72 h ficam alinhadas ao convite, que também pode criar um admin. Isso só vale com a conferência do e-mail (R4), o bloqueio por tentativas e a entrega fora de banda. Sem essas condições, volta a sugestão do parecer do #182 (24 h).
- No vencimento sem uso, o evento `ATIVACAO_VENCIDA` (severidade baixa, sem alarme imediato) vai para a fila da nossa equipe, que contata o fundador pelo canal do contrato.
- A reemissão é o mesmo comando com `--reemitir`: só enquanto **não houve ativação**, ela invalida a anterior e tem teto (3 por clínica). **Depois da ativação, não há reemissão.** Reemitir para uma conta que já tem senha e fator seria a nossa equipe tomando a conta do admin. Quem perde o acesso depois da ativação segue a recuperação por outro admin. O caso do admin único sem fator é uma lacuna separada (R10).

**3. Senha nova e TOTP na mesma sessão de 15 min, ou confirmar o `CTR-`? Decisão: a sessão de 15 min basta. O `CTR-` não entra. Entra a conferência do e-mail.**
- O `CTR-` não é segredo: aparece no contrato, no chamado e com a nossa equipe. Ele traz atrito e não traz segurança.
- O fundador digita o e-mail, conferido contra o HMAC como no convite (`convites.ts:143`). Isso amarra o token à pessoa do contrato e impede que um token vazado sozinho vire admin.
- A ordem segue a da recuperação: confere o token e o e-mail; confere a senha nova (tamanho de 12 a 128 e senha vazada pelo D15) **antes** de consumir o token; consome o token, cria a credencial e abre a sessão com `cadastro_pendente_ate` numa sequência com desfazer, igual ao aceite; e só então vêm `two-factor/enable` e `verify-totp`. O token não serve para nada além dessa sessão. Quem tem só a senha continua recebendo 403 `CADASTRO_SO_PELO_CONVITE`.

**4. Entra antes do B8? Decisão: sim, antes do B8 e como condição dele.**
- A fumaça do staging pede "clínica criada pelo fluxo de provisionamento".
- Sem o B11 não existe clínica real com login real.
- A troca, sugerida no #182, do `UPDATE` direto no teste de contrato por um caso que nasce do fundador entra junto.

## Ressalvas (condições para o PR de código)

- **R1 (minimização do e-mail).** Uma tabela no `identidade` (por exemplo `ativacao_do_fundador`) com estes campos, sem e-mail nem nome em claro e sem e-mail cifrado recuperável:
  - `id`, `clinica_id`, `usuario_id` (reservado ou existente), `email_hmac`, `conta_existente` (bool), `token_hash` (SHA-256), `contrato` (`CTR-\d{1,7}`, formato fechado), `criado_em`, `expira_em`, `usado_em`, `falhas`.
  - Só o `app_auth` tem acesso.
- **R2 (conta criada na ativação, não no provisionamento).**
  - **Conta nova:** a tarefa reserva o uuid (como `idParaContaDoConvite`) e chama `criarClinica` com ele. A conta nasce na ativação, com o nome e o e-mail digitados pelo fundador, como no aceite de pessoa nova. O espelho `vinculo` com uuid ainda sem conta já ocorre hoje no aceite.
  - **Conta existente** (o fundador já trabalha em outra clínica): a ativação exige login **completo** (senha e TOTP), não define senha nova e não abre sessão de cadastro. É o caminho de `aceitarComContaExistente`.
  - Uma conta `inativa_por = 'anonimizada'` ou `'expurgada'` nunca é reaproveitada.
- **R3 (entrega do token sem provedor de e-mail).**
  - A tarefa **não** imprime o token, e o banco não pode guardá-lo em claro.
  - A tarefa grava o token num parâmetro `SecureString` novo (`/provisionamento/<pedido>/entrega`). Uma **segunda pessoa** de `ops-provisionamento` lê o parâmetro uma vez, entrega o token ao fundador por canal fora de banda combinado no contrato (ligação de onboarding ou mensageria corporativa, nunca o e-mail em claro junto do link) e apaga o parâmetro. A tarefa agenda o apagamento no vencimento (72 h) como rede de segurança.
  - O token vai no **corpo** do `POST`. Se houver link, o token fica no fragmento (`#`), nunca na query (logs de ALB e CloudFront).
  - **Risco residual (o DPO assina):** quem entrega conhece o token e o e-mail, então poderia ativar no lugar do fundador. As mitigações:
    - controle de duas pessoas (uma provisiona, outra entrega);
    - `FUNDADOR_ATIVADO` dispara a confirmação, por canal fora de banda, de que foi o fundador quem ativou;
    - **o importador de dados (migração) só roda depois dessa confirmação**, e até lá a clínica não tem paciente.
    Esse risco desaparece quando houver provedor de e-mail transacional, que entrega o token direto ao fundador.
- **R4 (rota pública `POST /ativacao/usar`).**
  - **Mesmo 404** para token inválido, vencido, usado, de clínica sem ativação pendente ou com e-mail diferente. Nada de 410, que revela que o token existiu. A nossa equipe vê o motivo no log de segurança, nunca o usuário.
  - Rate limit da borda, no mesmo grupo de `/convites/aceitar` e `/recuperacao/usar`, com a mesma proteção de CSRF e de origem.
  - Contador **por origem** (HMAC do IP calculado no servidor) e **por ativação** (`falhas`). Na 5ª conferência de e-mail errada, o token é invalidado e sai `ATIVACAO_BLOQUEADA` (alarme alto). Volta só por reemissão.
  - Se o Redis cai: **falha fechada**, com 503 e `BLOQUEIO_INDISPONIVEL`, como a recuperação. Entrada mal formada não gasta tentativa.
  - O consumo é atômico: `UPDATE ... WHERE usado_em IS NULL AND expira_em > now() AND falhas < 5 RETURNING`.
- **R5 (D15 na senha nova).**
  - A senha nova passa pela mesma `conferirSenhaVazada` da troca e da recuperação: `senha_vazada` dá 409 sem consumir o token.
  - Enquanto o B2 estiver na opção D, a indisponibilidade da conferência segue aberta com `CONFERENCIA_DE_SENHA_INDISPONIVEL`, igual aos outros caminhos. A ativação não pode ter regra própria.
  - Se o segundo sócio votar por outra opção, a ativação acompanha no mesmo PR. Teste: senha vazada recusa e o token continua válido.
- **R6 (retenção).**
  - **Token:** só o hash. Linha vencida ou usada fica 30 dias e depois cai no expurgo diário, como o token de recuperação (`RIPD-identidade.md` §3). O `email_hmac` é zerado na ativação ou no vencimento.
  - **Prova:** a prova da emissão e da ativação fica na trilha da clínica, que segue a retenção da trilha, e no log de segurança (180 dias), não na linha do token. Assim, "o pedido fica pelo prazo do contrato" sai do desenho.
  - **Parâmetros SSM:** de vida curta, apagados pela tarefa ou no vencimento.
  - **Saída da tarefa no CloudWatch:** retenção do log de segurança.
  - O contrato (com o contato do fundador) tem a retenção da área comercial e entra na `matriz-retencao.md`.
- **R7 ("nossa equipe" e a prova de quem fez, no padrão do B10).**
  - Grupo IAM **nominal** `ops-provisionamento`, uma pessoa por usuário, com `aws:MultiFactorAuthPresent` e `SourceIdentity` obrigatório. Só ele tem `ecs:RunTask` nesta definição de tarefa e acesso aos parâmetros `/provisionamento/*`. O papel da API não tem `iam:PassRole` para o papel da tarefa.
  - A prova é o principal no CloudTrail, nunca um `--operador` declarado.
  - Quem provisiona e quem entrega são pessoas diferentes, e os dois nomes ficam no chamado `CTR-`.
  - **O id da pessoa da nossa equipe não entra na trilha da clínica** (Decisão 1 e R2 do B10). O operador fica no evento `CLINICA_PROVISIONADA` do log de segurança.
  - Na trilha da clínica, `tenant_create` e `member_found` saem com metadata fechada `{ op, via: 'provisionamento', contract: 'CTR-<n>' }`, e o ator deve ser **sistema**, não o fundador. Isso pede ajustar a conferência da 0022 (`founder_user_id` = usuário da transação) para aceitar o ator de sistema **só** com `via: 'provisionamento'`. Se o ajuste não couber no PR, o mínimo é o `via` na metadata, com o risco anotado no RIPD.
  - `founder_activated` sai com o fundador como ator.
- **R8 (isolamento e segredos da tarefa).**
  - Definição de tarefa própria, com só `app_auth`, `app_user`, a chave do HMAC por uso e o log de segurança. Sem `BETTER_AUTH_SECRET`: a conta nasce na ativação, pela API.
  - `criarClinica` roda com `withTenant` da clínica nova, e a linha de ativação guarda o `clinica_id`.
  - Na ativação, a transação abre **na clínica do token** e confere que o `usuario_id` é o `founder_user_id` da clínica e ainda está nela como admin ativo. Se não estiver, 404.
  - No máximo uma ativação pendente por clínica (índice único parcial).
  - Saída da tarefa: só `ok <clinica-uuid> <pedido-uuid>` ou um código fixo (`trava_incorreta`, `parametro_ausente`, `contrato_invalido`, `ja_provisionado`, `erro_parcial_rodar_de_novo`). Nunca a mensagem do driver.
  - Trava `CONFIRMA_PROVISIONAMENTO=<pedido>`. Idempotente: repetir o mesmo pedido não cria segunda clínica.
- **R9 (eventos e testes).**
  - Eventos: `CLINICA_PROVISIONADA`, `ATIVACAO_EMITIDA`, `ATIVACAO_REEMITIDA`, `ATIVACAO_FALHOU` (só ids e origem em HMAC), `ATIVACAO_BLOQUEADA`, `ATIVACAO_VENCIDA` e `FUNDADOR_ATIVADO`, todos na lista fechada. A trilha da clínica ganha `factor_enrollment_issued` (parecer do #182) e `founder_activated`.
  - Testes na bancada RLS, com dados fictícios:
    - fundador novo: token, e-mail e senha → `enable` 200; sem o token → 403 (R8);
    - fundador com conta existente: exige senha e TOTP e não abre sessão de cadastro;
    - e-mail errado → 404, e o 5º erro invalida o token;
    - token usado ou vencido → 404, igual ao inválido;
    - senha vazada não consome o token;
    - Redis fora → 503;
    - reemissão invalida a anterior; reemissão depois da ativação é recusada;
    - repetir a tarefa não duplica a clínica;
    - a metadata da trilha só tem as chaves fechadas, sem id de operador;
    - o stdout e o log não contêm e-mail, nome nem token;
    - o parâmetro SSM é apagado também quando a tarefa falha.
- **R10 (atualizar o RIPD e o checklist).**
  - `RIPD-identidade.md`:
    - §2: novo fluxo (o e-mail entra por SSM e fica só em HMAC; base legal art. 7º V, execução do contrato com a clínica, e art. 7º II e IX para os controles de segurança);
    - §3: prazos da R6;
    - §5: o risco residual da R3 e a lacuna do **admin único que perde o fator depois da ativação** (não há outro admin para emitir a recuperação). Essa lacuna vira item próprio do checklist, com procedimento operacional no padrão do B10: verificação da identidade pelo contrato, duas pessoas e chamado.
  - B11 no `prontidao-producao.md` aponta para este parecer.

## Checklist mínimo

| Item | Situação |
|---|---|
| Base legal (art. 7º e 11) | Art. 7º V para o e-mail e o nome do fundador; art. 7º II e IX para a segurança. Nada do art. 11 entra. Registrar no RIPD (R10). |
| Minimização | **Falha no desenho**: e-mail cifrado recuperável e conta criada cedo. Corrigida por R1, R2 e P1 (HMAC, SSM transitório, conta na ativação). |
| Consentimento | Não se aplica (contrato). |
| Criptografia em trânsito e em repouso | TLS na rota; SSM `SecureString` com KMS; token só em SHA-256; e-mail só em HMAC. |
| Isolamento por clínica | `withTenant` da clínica do token, conferência do fundador e uma ativação pendente por clínica (R8). |
| Controle de acesso | R8 intacta; IAM nominal com MFA (R7); sem reemissão depois da ativação (P2). |
| Log de auditoria | Ator e metadata (R7); eventos fechados (R9). |
| Retenção | R6; o prontuário não é tocado (20 anos, inalterado). |
| Segredos fora do código e dados reais fora do git | Token e e-mail nunca em argumento, log ou git; testes só com dados fictícios. |
| CFM, ANS e ICP-Brasil | MFA do admin desde o primeiro acesso (CFM 2.299/2021, autenticação forte). Assinatura ICP-Brasil não é tocada. |
