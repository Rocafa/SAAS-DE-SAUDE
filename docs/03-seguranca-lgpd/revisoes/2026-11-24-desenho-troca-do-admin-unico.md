# Parecer do Guardião: desenho da troca do admin único que perdeu senha e fator (B13)

> 24/11/2026 · Guardião LGPD & Segurança · parecer de **desenho** (sem código) sobre o v1 de [`docs/04-arquitetura/troca-do-admin-unico.md`](../../04-arquitetura/troca-do-admin-unico.md), PR #238 (`eng/desenho-b13`).
> Transcrição fiel do parecer publicado como comentário no #238 em 24/11/2026. Os números P1 a P10 são as perguntas da seção 15 do desenho v1.

## Veredito: **APROVADO COM RESSALVAS**

## Ressalvas

1. Concluir e revogar o vínculo antigo **só quando o TOTP da conta nova for confirmado**, e não no `POST /ativacao/usar`. Do contrário, a clínica pode ficar sem admin com fator.
2. Sem provedor de e-mail, o "não fui eu" enfraquece. Por isso, a ligação de retorno ao telefone do contrato vira **confirmação de viva voz obrigatória** no `pedir` e de novo antes do `emitir`. O risco fica aceito até a D3 e é registrado no RIPD §4/§8.
3. Um **trigger de transições** em `troca_do_admin`. O `usuario_novo` só nasce por `consumirAtivacao` com origem `troca`.
4. Guardar o **operador do `pedir`** (só no schema identidade) e recusar `mesmo_operador` no `emitir`.
5. Um **login completo da conta antiga depois da conclusão** dispara alarme crítico ao DPO. No último vínculo, a conta vira `substituida`.

## Decisões do Guardião

| Pergunta | Decisão |
|---|---|
| P3 (terceira pessoa na emissão) | **Sim**: terceira pessoa. O DPO não conta como uma delas |
| P4 (conta antiga com vínculo em outras clínicas) | **Sem aviso** entre clínicas |
| P7 (papel de banco) | **Ampliar** o `app_provisionamento` |
| P8 (perfis da conta nova) | A conta nova **não herda** perfis |
| P9 (validade do token) | **24 h** |
| P10 (conta nova ou existente) | **Só conta nova** no v1 |

## Para os sócios: decisão dos sócios (recomendação técnica do Guardião)

| Pergunta | Recomendação |
|---|---|
| P1 (tamanho da janela) | **Decisão dos sócios.** Recomendação: 48 h corridas, com pelo menos um dia útil inteiro |
| P2 (suspender a conta antiga no T0 com suspeita de invasão) | **Decisão dos sócios.** Recomendação: sim, com a decisão do DPO registrada |
| P5 (quem indica o admin novo quando o signatário saiu ou faleceu) | **Decisão dos sócios.** Recomendação: só o representante legal, com poderes comprovados. O modelo depende do advogado (D8) |
| P6 (reversão depois da conclusão) | **Decisão dos sócios.** Recomendação: o DPO e os dois sócios decidem, com as sessões da conta nova suspensas até a decisão |
