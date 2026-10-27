# Termo de migração de dados (importador de planilha)

> ⚖️ **RASCUNHO a validar pelo advogado** (entra no `pacote-advogado.md`). Base: R4 e decisão 2.1 do parecer do Guardião sobre o importador ([2026-10-16-importador.md](revisoes/2026-10-16-importador.md)).
> Versão vigente: **`mig-02.4-v1`**. O aceite grava no lote a versão **e o SHA-256 do texto abaixo** (`import_batches.term_sha256`); `GET /importacoes/termo` devolve o texto e o hash. A fonte do texto servido é `apps/api/src/modules/imports/termo-migracao.ts`, e o teste `termo-migracao.test.ts` confere que o trecho entre os marcadores abaixo é idêntico a ela.
> Regra de versão: mudou uma vírgula, nasce uma versão nova (`mig-02.4-v2`). A versão aceita nunca é editada; lotes antigos continuam apontando para o texto que foi aceito (histórico no git).

## Texto (v1)

<!-- termo:inicio -->
Termo de migração de dados (versão mig-02.4-v1)

1. Quem é quem. A clínica que envia o arquivo é a CONTROLADORA dos dados nele contidos e declara que eles são de pacientes DELA. A plataforma atua como OPERADORA (LGPD, art. 5º, VII, e art. 39), nos termos do contrato e do acordo de tratamento de dados (DPA) já aceitos.

2. Origem do arquivo. A clínica declara que obteve o arquivo do sistema que usava antes pelos meios previstos no contrato dela com aquele fornecedor, e que o arquivo não contém dados de pacientes de outra clínica.

3. Finalidade única. O arquivo serve apenas para carregar o cadastro de pacientes e a agenda futura da clínica nesta plataforma. É a continuação do mesmo tratamento que a clínica já realiza, sob as mesmas bases legais.

4. Campos aceitos. Pacientes: nome, nome social, CPF, telefone e data de nascimento. Agenda: CPF ou nome do paciente, data, hora, profissional e tipo de atendimento. Colunas excedentes não são importadas e são descartadas junto com o arquivo.

5. O que não enviar. Exporte só as colunas necessárias. Não envie evolução clínica, diagnóstico, CID, anexos, exames nem qualquer outro dado de saúde.

6. Prazo do arquivo. O arquivo original fica guardado só cifrado e é descartado em até 7 dias, ou antes, ao aplicar a importação. Cópias de segurança cifradas do banco podem conter o arquivo até o fim do prazo de retenção dos backups, sem acesso pelo aplicativo.

7. Uso proibido. A plataforma não usa os dados do arquivo para nenhum outro fim: nem estatística, nem comparação entre clínicas, nem inteligência de mercado, nem treino de inteligência artificial.

8. Conferência e desfazer. Antes de gravar, a clínica vê a simulação (o que será criado e o que será ignorado). Depois de aplicar, a importação pode ser desfeita enquanto nenhum registro importado tiver sido usado (atendimento, prontuário, financeiro, agenda nova ou edição). Depois disso, a correção é feita registro a registro.

9. Exatidão. A clínica é responsável pela exatidão e pela atualização dos dados enviados (LGPD, art. 6º, V).

10. Sistema anterior. A eliminação dos dados no sistema anterior é assunto entre a clínica e aquele fornecedor.

11. Incidente. Se a clínica perceber que enviou o arquivo errado, ou de outra clínica, deve avisar imediatamente pelo canal de incidentes informado no contrato. A plataforma ajuda a identificar os registros afetados e a eliminá-los, com registro na trilha.
<!-- termo:fim -->

## Perguntas ao advogado

1. O item 6 (backup) basta como informação do prazo real, ou é preciso o *crypto-shredding* por lote (R3) antes da 1ª importação real?
2. O item 2 (declaração de origem) somado à confirmação do nome da clínica no aplicar (R6) é diligência suficiente contra arquivo de outra clínica?
3. O aceite eletrônico do admin (versão + hash + quem + quando) vale como instrução documentada do controlador (art. 39), ou o termo precisa ser assinado pelo representante legal da clínica?
