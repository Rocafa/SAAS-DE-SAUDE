/**
 * Declaração da cobertura de auditoria das rotas de escrita (#105, S6). Toda rota `POST/PATCH/PUT/DELETE` da API
 * tem de estar em UMA das duas listas; rota nova fora delas falha o CI (cobertura-auditoria.test.ts), com o nome.
 *
 * - `AUDITADAS`: o teste prova, pelo compilador, que existe caminho de chamada do handler até `insertAudit`
 *   (src/modules/audit/audit-log.ts), na transação de quem age.
 * - `EXCECOES`: sem gravação pelo código da API, com o motivo. `banco`: a trilha é gravada por função SQL (o teste
 *   confere o INSERT em audit_log na última definição da função). `sem_efeito`: a rota não muda nada.
 *
 * Leitura (R5 do parecer de 03/11/2026): toda rota `GET` está em `AUDITADAS_LEITURA` (mesma prova de alcance) ou em
 * `LEITURA_SEM_DADO_DE_PACIENTE` (com o motivo); rota sob caminho clínico (`ehCaminhoClinico` no teste) nunca é exceção.
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

// ------------------------------------------------------------------ leitura (R5 do parecer de 03/11/2026)

/** Rotas de leitura (`GET`) cuja trilha é gravada pelo código da API (o titular e a clínica veem quem leu). */
export const AUDITADAS_LEITURA: readonly string[] = [
  'GET /agendamentos',
  'GET /clinica/auditoria',
  'GET /atendimentos/:id',
  'GET /atendimentos/do-agendamento/:agendamentoId',
  'GET /atendimentos/:id/versoes',
  'GET /clinica/portal/pacientes/:id/consentimentos',
  'GET /clinica/portal/pacientes/:id/vinculos',
  'GET /clinica/portal/solicitacoes',
  'GET /clinica/portal/solicitacoes/:id',
  'GET /convenios',
  'GET /convenios/:id/relatorio',
  'GET /custodias/:id/notas',
  'GET /financeiro/caixas',
  'GET /financeiro/caixas/:id',
  'GET /financeiro/cobrancas/:id',
  'GET /financeiro/configuracao',
  'GET /financeiro/contas-a-receber',
  'GET /financeiro/profissionais/:id/perfil-fiscal',
  'GET /financeiro/recibos',
  'GET /financeiro/recibos/:id',
  'GET /guias',
  'GET /guias/:id',
  'GET /guias/:id/consumos',
  'GET /guias/alertas',
  'GET /importacoes',
  'GET /importacoes/:id',
  'GET /importacoes/:id/divergencias',
  'GET /notas-privadas/:id',
  'GET /pacientes',
  'GET /pacientes/:id',
  'GET /pacientes/:id/notas-privadas',
  'GET /pacientes/:id/prontuario',
  'GET /pacientes/:id/responsaveis',
  'GET /pacientes/:id/responsaveis/:vinculoId/historico',
  'GET /pacientes/:id/responsaveis/sigilo',
  'GET /pacientes/:id/whatsapp/opt-in',
  'GET /pacotes',
  'GET /pacotes/:id',
  'GET /pacotes/:id/historico',
  'GET /portal/consultas',
  'GET /portal/documentos',
  'GET /portal/meus-dados',
  'GET /portal/privacidade/consentimentos',
  'GET /portal/privacidade/consentimentos/:finalidade/historico',
  'GET /portal/recibos',
  'GET /portal/recibos/:id',
  'GET /portal/sessao',
  'GET /portal/solicitacoes',
  'GET /portal/vinculos',
  'GET /prontuario/configuracao',
  'GET /suporte/autorizacoes',
  'GET /whatsapp/envios',
];

/**
 * Rotas de leitura sem trilha, com o motivo: não devolvem dado de paciente nem conteúdo clínico (algumas devolvem dado
 * da equipe, dito no motivo). Rota sob
 * caminho clínico (CAMINHOS_CLINICOS no teste) nunca entra aqui. Mudar exige parecer do Guardião.
 */
export const LEITURA_SEM_DADO_DE_PACIENTE: Readonly<Record<string, string>> = {
  'GET /avisos':
    'avisos do próprio destinatário (filtro pelo usuário da sessão): ids técnicos, tipo e datas; o aviso de transição do sigilo traz o pacienteId e a transição (que pode deixar inferir incapacidade), aceito porque a criação do aviso é auditada e o passo seguinte (abrir o paciente) também',
  'GET /clinica/membros':
    'equipe da clínica: id do usuário, perfil, quem concedeu e quando (sem nome, e-mail nem dado de paciente); concessão e revogação são auditadas',
  'GET /clinica/vinculo-de-cuidado':
    'configuração da clínica (se o vínculo de cuidado vale); sem dado pessoal',
  'GET /financeiro/retencao-fiscal':
    'política de retenção fiscal da clínica (prazos); sem dado pessoal; a execução é auditada',
  'GET /health':
    'saúde do processo para o balanceador; sem sessão e sem dado',
  'GET /health/ready':
    'prontidão (banco e dependências) para o balanceador; sem sessão e sem dado',
  'GET /importacoes/termo':
    'texto e versão do termo de migração e limites do arquivo; constantes, sem dado',
  'GET /profissionais':
    'cadastro da agenda: nome, especialidade, capacidade e marca de área sensível de cada profissional (dado da equipe exibido ao agendar), sem dado de paciente',
  'GET /sessao':
    'a própria sessão: id do usuário, id da clínica e perfis, todos já do contexto de quem pede',
  'GET /tipos-atendimento':
    'cadastro da agenda: tipos de atendimento e duração; sem dado pessoal',
  'GET /whatsapp/configuracao':
    'configuração do WhatsApp da clínica (ligado, antecedência dos lembretes); sem dado pessoal',
  'GET /whatsapp/modelos':
    'lista fechada de modelos neutros de mensagem; constantes, sem dado',
  'GET /whatsapp/webhook':
    'desafio de verificação do provedor (hub.challenge); sem sessão e sem dado',
};

// ------------------------------------------------------------------ fora de controller (R6 do parecer do #117)

/**
 * Handlers HTTP registrados fora de controller do Nest (`"<arquivo> <método>(<1º argumento>)"`), com o motivo. Hoje só
 * middlewares de segurança, que não leem nem gravam dado de paciente. O handler de login da D4 (Better Auth) entra
 * aqui com parecer do Guardião e com a auditoria de login, logout, falha e troca de credencial (condição da D4).
 */
export const HANDLERS_FORA_DE_CONTROLLER: Readonly<Record<string, string>> = {
  'src/security/http-security.ts use(helmet)': 'cabeçalhos de segurança (CSP, HSTS, frame); não toca dado',
  'src/security/http-security.ts use(noStore)': 'Cache-Control: no-store em toda resposta; não toca dado',
  'src/security/http-security.ts use(rateLimiter)': 'limite de requisições por chave com hash (sem IP em claro); não toca dado de paciente',
  'src/security/http-security.ts use(montagemDaAutenticacao)':
    'login da D4 (Better Auth, src/modules/auth/better-auth/montagem.ts): lista fechada de endpoints (entrar, sair, ler sessão); login aceito, recusado e logout no log de segurança; troca de clínica e MFA na trilha da clínica pelas nossas funções (R6 do #117; parecer do desenho de 05/11)',
  'src/security/http-security.ts use(protecaoCsrf)': 'CSRF (E6 de 04/11): recusa escrita de origem fora da allowlist e corpo que não é JSON; não lê o corpo nem toca dado',
  'src/security/http-security.ts use(safeErrorHandler)': 'erro sem detalhe interno nem dado na resposta; não toca dado',
};

// ------------------------------------------------------------------ filas, jobs e eventos (R3.3/R6)

export type DeclaracaoHandlerAssincrono =
  | { readonly auditoria: 'job'; readonly trilha: 'sempre' | 'com_efeito'; readonly motivo: string }
  | { readonly auditoria: 'executor_central' | 'propria' | 'sem_dado'; readonly motivo: string };

/**
 * Lista fechada dos handlers fora de controller que entram por fila, agendamento ou evento. `job` usa a trilha por
 * clínica do ExecutorDeJobs (inclusive na falha); `executor_central` é o único trabalhador que despacha para ele.
 * `propria` exige caminho do callback até insertAudit; `sem_dado` exige motivo e não pode alcançar a trilha. Handler
 * novo, removido ou com política alterada falha o CI. Mudar esta lista exige parecer do Guardião LGPD.
 */
export const HANDLERS_ASSINCRONOS: Readonly<Record<string, DeclaracaoHandlerAssincrono>> = {
  'evento src/modules/jobs/jobs.module.ts setInterval(error)': {
    auditoria: 'sem_dado',
    motivo: 'aviso periódico de agendador desligado; repete código e motivo fixos, sem ler dado pessoal',
  },
  'evento src/modules/jobs/jobs.module.ts setInterval(verificarAtrasos)': {
    auditoria: 'sem_dado',
    motivo: 'sinal de vida lê somente nomes, prazos e datas técnicas dos jobs; não acessa dado pessoal',
  },
  'fila src/modules/jobs/agendador-bullmq.ts Worker(processadorSeguro(processar))': {
    auditoria: 'executor_central',
    motivo: 'único trabalhador BullMQ; despacha todo job ao ExecutorDeJobs, que registra a trilha por clínica',
  },
  'job whatsapp-lembretes': {
    auditoria: 'job',
    trilha: 'com_efeito',
    motivo: 'cada envio já audita a própria ação; o executor registra efeito, retry e falha sem encher a trilha de zeros',
  },
  'job whatsapp-retencao': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'retenção de envios e conteúdo pessoal; o serviço e o executor registram a execução diária',
  },
  'job portal-representacoes': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'revogação de vínculos e consentimentos; funções do banco e executor registram a execução diária',
  },
  'job portal-titular-menor': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'lê nascimento e revoga acesso de titular menor; função do banco e executor registram a execução',
  },
  'job importador-expurgo': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'descarte de arquivos pessoais importados e chaves; serviço e executor registram a execução diária',
  },
  'job notas-privadas-ciclo': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'custódia e expurgo de notas clínicas privadas; serviço e executor registram a execução diária',
  },
  'job retencao-fiscal': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'retém recibos, cobranças e pagadores; serviço e executor registram a execução diária',
  },
  'job responsaveis-descarte': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'descarte de cadastro pessoal de responsáveis; serviço e executor registram a execução diária',
  },
  'job cpf-indice-reindexacao': {
    auditoria: 'job',
    trilha: 'sempre',
    motivo: 'reindexação de CPF e descarte de chaves; serviço e executor registram a execução diária',
  },
};

// ------------------------------------------------------------------ MFA recente (R4 do parecer de 03/11 sobre o #123)

/**
 * Rotas que exigem MFA recente (`@ExigeMfaRecente`). Tirar ou pôr o decorator sem atualizar esta lista falha o CI.
 * Conteúdo clínico mais sensível (notas privadas, custódia) e ações irreversíveis ou de alto impacto (R2 do parecer).
 */
export const ROTAS_COM_MFA_RECENTE: readonly string[] = [
  'DELETE /clinica/membros/:usuarioId/:perfil',
  'GET /clinica/auditoria',
  'GET /custodias/:id/notas',
  'GET /notas-privadas/:id',
  'GET /pacientes/:id/notas-privadas',
  'PATCH /notas-privadas/:id',
  'POST /clinica/membros',
  'POST /clinica/portal/convites',
  'POST /clinica/portal/solicitacoes/:id/situacao',
  'POST /custodias/:id/aceite',
  'POST /custodias/:id/notas/:notaId/decisao',
  'POST /financeiro/receita-saude/lotes',
  'POST /financeiro/recibos/:id/via-oficial',
  'POST /financeiro/retencao-fiscal/execucao',
  'POST /importacoes/:id/aplicar',
  'POST /importacoes/:id/desfazer',
  'POST /notas-privadas/:id/descartar',
  'POST /pacientes/:id/notas-privadas',
  'POST /pacientes/:id/responsaveis/eliminacao',
  'POST /pacientes/:id/responsaveis/sigilo/:pedidoId/revogar',
  'POST /profissionais',
  'POST /profissionais/:id/area-sensivel',
  'POST /prontuario/custodias',
  'POST /prontuario/notas-privadas/ciclo',
  'POST /prontuario/pacientes/:id/retencao-legal/retirada',
  'POST /prontuario/pacientes/:id/retencao-legal/retirada/aprovacao',
  'POST /prontuario/profissionais/:id/desligamento',
  'POST /responsaveis/descarte',
  'POST /suporte/autorizacoes',
  'PUT /clinica/vinculo-de-cuidado',
  'PUT /financeiro/configuracao',
  'PUT /financeiro/profissionais/:id/perfil-fiscal',
  'PUT /prontuario/configuracao',
  'PUT /whatsapp/configuracao',
];
