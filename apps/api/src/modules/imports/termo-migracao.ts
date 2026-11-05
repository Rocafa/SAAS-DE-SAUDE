import { createHash } from 'node:crypto';

/**
 * R4 do parecer do importador: TEXTO do termo de migração (instrução documentada do controlador para esta
 * operação, LGPD art. 39). Versionado: o aceite grava a versão E o SHA-256 deste texto no lote, e
 * `GET /importacoes/termo` serve o texto e o hash. A cópia legível fica em
 * docs/03-seguranca-lgpd/termo-migracao.md, e um teste confere que as duas são idênticas.
 *
 * ⚖️ RASCUNHO a validar pelo advogado (pacote-advogado.md). Mudou o texto: nova versão (`-v2`), nunca
 * edição silenciosa da versão aceita.
 */
export const TERMO_MIGRACAO_TEXTO = `Termo de migração de dados (versão mig-02.4-v1)

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

11. Incidente. Se a clínica perceber que enviou o arquivo errado, ou de outra clínica, deve avisar imediatamente pelo canal de incidentes informado no contrato. A plataforma ajuda a identificar os registros afetados e a eliminá-los, com registro na trilha.`;

/** SHA-256 (hex) do texto do termo: vai no aceite gravado no lote. */
export const TERMO_MIGRACAO_SHA256 = createHash('sha256').update(TERMO_MIGRACAO_TEXTO, 'utf8').digest('hex');
