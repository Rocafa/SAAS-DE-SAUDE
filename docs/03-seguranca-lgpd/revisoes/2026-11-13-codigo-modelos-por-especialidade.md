# Revisão de código: modelos do prontuário v2 por especialidade (PR #193, parte da API da #167)

**Veredito: APROVADO no recorte LGPD/segurança, com merge condicionado a C1 e C2.**
Nenhuma categoria nova de dado, nenhum caminho novo de saída, cifragem/RLS/auditoria/retenção intocados. C1 é teste
que vai quebrar no CI (não é verde falso, é vermelho previsível); C2 é rejeição indevida de dado clínico válido.

Revisor: guardiao-lgpd · Data: 13/11/2026 · Commit: `4b6a0c0` · Diff: `git diff origin/main...HEAD` (4 arquivos, +105/−14)
Teste unitário rodado: `apps/api/src/modules/records/modelos.test.ts` 13/13 verde. Testes RLS não rodados localmente
(job "Isolamento entre tenants (RLS)" ainda pendente no PR).

## Correções antes do merge

**C1. `apps/api/test/prontuario.rls.test.ts:265` vai falhar.** Afirma `versaoModelo: 1` num salvamento de fisio; com
`MODELOS.fisio.versao = 2` (`modelos.ts:66`) o serviço grava `templateVersion: 2` (`prontuario.service.ts:245`) e devolve
2 (`prontuario.service.ts:572`). Trocar para `MODELOS.fisio.versao` (não o literal 2, para não quebrar na v3).

**C2. Subescalas da MIF rejeitadas por engano (`modelos.ts:119`, `modelos.ts:123-131`).** O casamento é por palavra:
"MIF motora" (faixa real 13–91) e "MIF cognitiva" (5–35) casam `mif` e herdam 18–126, então valores válidos abaixo de 18
dão 400. Correção mínima: só aplicar a faixa da MIF quando o rótulo não trouxer `motora`/`motor`/`cognitiva`/`cognitivo`
(ou dar faixa própria a cada subescala), e um teste para cada caso. Qualidade do dado é princípio (LGPD art. 6º V).

## Conferência pedida

1. **Aditivo e compatível: OK, com uma ressalva de semântica.**
   - Leitura: `validarConteudo` só roda no salvamento (`prontuario.service.ts:235`); nada reinterpreta versão gravada.
     Exportação e leitura devolvem o JSON decifrado como está.
   - Salvar registro v1: os textos da v1 seguem aceitos (`modelos.ts:61`, `69`, `79`). Mas todo salvamento novo grava a
     versão ATUAL do modelo (`prontuario.service.ts:245`). Um rascunho TO aberto antes do deploy e salvo de novo vira v2 e
     passa a exigir `objetivo`/`atividades`. É coerente com PRO-01.4 (a regra é da versão gravada) e com a tela, que já pede
     esses dois como obrigatórios (`apps/web/lib/prontuario.ts:39-40`). O comentário em `modelos.ts:289-291` ("registro da
     v1 segue a regra da v1") deve dizer "versão gravada na v1", para não sugerir o contrário. (P3)
   - Finalizar v1 pela regra da v1: correto (`modelos.ts:292-295`, `prontuario.service.ts:276`). O hash da finalização já
     inclui `templateVersion` (`prontuario.service.ts:285`). Fallback para a regra atual quando a versão não está
     mapeada é aceitável (fisio v1 = v2 nos obrigatórios).
   - Ressalva menor: rascunho antigo com escala "Barthel" fora de 0–100 passa a dar 400 no próximo autosave. Só afeta
     rascunho, e com o nome do campo, sem o valor. (P3)
2. **Base regulatória e minimização: OK.** `diagnostico` (COFFITO 414/2012 art. 1º §1º V) e `exames` (inciso IV) são
   conteúdo mínimo exigido; `objetivo`, `atividades`, `desempenho`, `nivel_assistencia` e `plano` são o registro da
   sessão de TO (COFFITO 415/2012) que a tela já coleta. Mesma finalidade (tutela da saúde, LGPD art. 11 II "f"), mesmo
   cofre: tudo entra em `contentEnc` cifrado por campo, com RLS e auditoria sem conteúdo (`prontuario.service.ts:238-258`).
   Nenhum campo novo identifica terceiro nem cria dado sensível fora do que o prontuário já é. Limite de 20 mil caracteres
   vale para todos.
3. **Escalas: faixas certas, com dois pontos.** Barthel 0–100, MIF 18–126 (total), Berg 0–56 e NPRS 0–10, todas
   inteiras: corretas. Casamento por palavra inteira evita "Bergamota" (testado). Problemas: C2 (subescalas da MIF) e o
   Barthel na pontuação 0–20 (Collin & Wade) passa na faixa 0–100 e mistura escalas no gráfico (P3: pedir rótulo
   "Barthel 0–20" ou recusar). Rótulo com dois instrumentos ("Barthel e MIF") pega o primeiro da lista. A solução de
   fundo é campo `instrumento` explícito (ver #167 abaixo). COPM fora: correto (`modelos.ts:113`), licença não conferida.
4. **Psicologia sem instrumento: OK.** `medidas: false` mantido (`modelos.ts:90`) e testado
   (`modelos.test.ts:135-138`); comentário cita Res. CFP 31/2022 (`modelos.ts:113-114`).
5. **Exportação (G2) e retenção: inalteradas.** `tenant-export.ts` não depende de nome de campo; o teste de cobertura só
   ganhou `objetivo`/`atividades` fictícios para a TO v2 finalizar (`exportacao-cobertura.rls.test.ts:301`); a asserção da
   linha 755 e a varredura de conteúdo na trilha (758) seguem iguais. Retenção de 20 anos não tocada.
6. **Testes sem verde falso: OK no unitário; falta integração.** As asserções conferem nomes de campo e listas exatas
   (`modelos.test.ts:73-81`, `121-154`). Falta (P2) um teste RLS que finalize pelo serviço uma versão gravada com
   `template_version = 1` de TO só com `queixa`/`conduta` (hoje a regra v1 só é provada na função pura). Dados de teste são
   fictícios; nada real, segredo ou certificado no diff.

## O que a #167 ainda exige do backend

- COFFITO 414 art. 2º §1º: identificar supervisor/responsável técnico quando quem registra é estagiário (campo e regra
  na finalização).
- Catálogo de escalas tipado (`instrumento` explícito em vez de casar rótulo), incluindo EVA/NPRS, MRC, goniometria por
  articulação e subescalas da MIF.
- Medidas por especialidade: TO hoje herda o conjunto da fisio (goniometria, perimetria); restringir a Barthel/MIF.
- Tratar 5 anos (COFFITO 414 art. 6º I; Res. CFP 001/2009) como piso e manter 20 anos (Lei 13.787/2018) como regra.
- COFFITO 414 art. 4º/5º: prontuário pertence ao paciente; garantir acesso visível na tela (G2 já cobre a saída).
