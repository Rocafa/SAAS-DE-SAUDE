/**
 * Declaração da cobertura de auditoria das rotas de escrita (#105, S6). Toda rota `POST/PATCH/PUT/DELETE` da API
 * tem de estar em UMA das duas listas; rota nova fora delas falha o CI (cobertura-auditoria.test.ts), com o nome.
 *
 * - `AUDITADAS`: o teste prova, pelo compilador, que existe caminho de chamada do handler até `insertAudit`
 *   (src/modules/audit/audit-log.ts), na transação de quem age.
 * - `EXCECOES`: sem gravação pelo código da API, com o motivo. `banco`: a trilha é gravada por função SQL (o teste
 *   confere o INSERT em audit_log na última definição da função). `sem_efeito`: a rota não muda nada.
 *
 * Mudar uma rota de lista exige parecer do Guardião LGPD.
 */

/** Rotas de escrita cuja trilha é gravada pelo código da API. */
export const AUDITADAS: readonly string[] = [
  'DELETE /clinica/membros/:usuarioId/:perfil',
  'PATCH /convenios/:id',
  'PATCH /guias/:id',
  'PATCH /notas-privadas/:id',
  'PATCH /pacientes/:id',
  'PATCH /pacientes/:id/responsaveis/:vinculoId',
  'POST /agendamentos',
  'POST /agendamentos/:id/cancelar',
  'POST /agendamentos/:id/check-in',
  'POST /agendamentos/:id/remarcar',
  'POST /agendamentos/:id/status',
  'POST /atendimentos',
  'POST /atendimentos/:id/adendos',
  'POST /atendimentos/:id/finalizar',
  'POST /avisos/:id/lido',
  'POST /clinica/membros',
  'POST /clinica/portal/convites',
  'POST /clinica/portal/convites/:id/revogar',
  'POST /clinica/portal/solicitacoes/:id/situacao',
  'POST /clinica/portal/vinculos/:id/revogar',
  'POST /convenios',
  'POST /convenios/:id/inativar',
  'POST /custodias/:id/aceite',
  'POST /custodias/:id/notas/:notaId/decisao',
  'POST /financeiro/caixas',
  'POST /financeiro/caixas/:id/fechar',
  'POST /financeiro/cobrancas',
  'POST /financeiro/cobrancas/:id/cancelar',
  'POST /financeiro/cobrancas/:id/recebimentos',
  'POST /financeiro/recebimentos/:id/estornar',
  'POST /financeiro/recebimentos/:id/pagador-responsavel',
  'POST /financeiro/recebimentos/:id/recibo',
  'POST /financeiro/receita-saude/lotes',
  'POST /financeiro/recibos/:id/cancelar',
  'POST /financeiro/recibos/:id/via-oficial',
  'POST /financeiro/retencao-fiscal/execucao',
  'POST /guias',
  'POST /guias/:id/cancelar',
  'POST /guias/:id/consumos',
  'POST /guias/:id/consumos/:consumoId/assinatura',
  'POST /guias/:id/consumos/:consumoId/estornar',
  'POST /importacoes',
  'POST /importacoes/:id/aplicar',
  'POST /importacoes/:id/desfazer',
  'POST /importacoes/:id/simular',
  'POST /importacoes/:id/validar',
  'POST /notas-privadas/:id/descartar',
  'POST /pacientes',
  'POST /pacientes/:id/inativar',
  'POST /pacientes/:id/notas-privadas',
  'POST /pacientes/:id/responsaveis',
  'POST /pacientes/:id/responsaveis/:vinculoId/anular',
  'POST /pacientes/:id/responsaveis/:vinculoId/encerrar',
  'POST /pacientes/:id/responsaveis/:vinculoId/pagador',
  'POST /pacientes/:id/responsaveis/eliminacao',
  'POST /pacientes/:id/responsaveis/emancipacao',
  'POST /pacientes/:id/responsaveis/sigilo',
  'POST /pacientes/:id/responsaveis/sigilo/:pedidoId/revogar',
  'POST /pacientes/:id/whatsapp/opt-in',
  'POST /pacientes/:id/whatsapp/opt-in/revogar',
  'POST /pacientes/busca',
  'POST /pacotes',
  'POST /pacotes/:id/cancelar',
  'POST /pacotes/:id/consumos',
  'POST /pacotes/:id/consumos/:consumoId/estornar',
  'POST /pacotes/:id/profissional',
  'POST /portal/consultas/:id/cancelar',
  'POST /portal/consultas/:id/confirmar',
  'POST /portal/consultas/:id/desfazer-confirmacao',
  'POST /portal/convites/resgate',
  'POST /portal/meus-dados/correcao',
  'POST /portal/privacidade/consentimentos/:finalidade',
  'POST /portal/privacidade/consentimentos/:finalidade/desfazer',
  'POST /portal/sessao/vinculo',
  'POST /portal/solicitacoes',
  'POST /profissionais',
  'POST /profissionais/:id/area-sensivel',
  'POST /prontuario/custodias',
  'POST /prontuario/notas-privadas/ciclo',
  'POST /prontuario/pacientes/:id/retencao-legal/retirada',
  'POST /prontuario/pacientes/:id/retencao-legal/retirada/aprovacao',
  'POST /prontuario/profissionais/:id/desligamento',
  'POST /responsaveis/descarte',
  'POST /suporte/autorizacoes',
  'POST /suporte/autorizacoes/:id/revogar',
  'POST /tipos-atendimento',
  'POST /whatsapp/lembretes/execucao',
  'POST /whatsapp/retencao/execucao',
  'POST /whatsapp/webhook',
  'PUT /atendimentos/:id/registro',
  'PUT /clinica/vinculo-de-cuidado',
  'PUT /financeiro/configuracao',
  'PUT /financeiro/profissionais/:id/perfil-fiscal',
  'PUT /importacoes/:id/mapeamento',
  'PUT /prontuario/configuracao',
  'PUT /prontuario/pacientes/:id/retencao-legal',
  'PUT /whatsapp/configuracao',
];

export type Excecao =
  | { readonly tipo: 'banco'; readonly funcaoSql: string; readonly motivo: string }
  | { readonly tipo: 'sem_efeito'; readonly motivo: string };

/** Rotas de escrita sem gravação da trilha pelo código da API, com o motivo. */
export const EXCECOES: Readonly<Record<string, Excecao>> = {
  'POST /portal/convites/resgate/confirmar': {
    tipo: 'banco',
    funcaoSql: 'app_portal_redeem_invite',
    motivo: 'o resgate roda sem contexto de clínica (a conta ainda não tem vínculo); a função SECURITY DEFINER cria o vínculo e grava a trilha na mesma transação',
  },
  'POST /whatsapp/modelos': {
    tipo: 'sem_efeito',
    motivo: 'modelo próprio da clínica desligado: a rota sempre responde 409 (modelo_da_clinica_desligado) sem tocar no banco',
  },
};
