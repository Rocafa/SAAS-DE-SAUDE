/**
 * CONTRATO `ApiPortal` — fonte ÚNICA das rotas do portal do paciente (`/portal/*`), publicada pelo
 * backend (apps/api/src/modules/portal) para o front (apps/web) importar. P1 do parecer de 24/10
 * (docs/03-seguranca-lgpd/revisoes/2026-10-24-front-vetos.md).
 *
 * Regras que o contrato carrega:
 * - Nenhuma rota recebe id de paciente ou de clínica: o titular sai da SESSÃO do portal (PortalGuard).
 *   GET não aceita query (400). Ids na URL só de consulta, recibo e finalidade; alheio = 404.
 * - Valores em CENTAVOS (inteiro). Datas `AAAA-MM-DD` e horas `HH:MM` no fuso da clínica; instantes ISO.
 * - Enums com os nomes EXATOS do backend (o front mapeia só na exibição).
 * - "De quem" é o acesso: `agindoComo` = `titular` ou `responsavel_legal` (responsável da 0028).
 * - Responsável e titular recebem os MESMOS formatos, e NENHUM é clínico: agenda, financeiro, cadastro,
 *   pedidos e consentimentos. Prontuário não sai pelo portal. A conferência estrita (`conferirForma`)
 *   faz um campo novo quebrar o teste de contrato; `CAMPOS_CLINICOS_PROIBIDOS` é só alarme por NOME.
 * - O que o backend já decide (sigilo do adolescente, prazo, botões, protocolo, texto do consentimento)
 *   vem pronto; o front não recalcula.
 */
import { chavesDaForma, conferirForma, f, type Forma, type FormaOpcional, type Infer } from './forma.js';

// ------------------------------------------------------------------ enums (nomes exatos do backend)

/** Quem age pelo vínculo: o próprio titular ou o responsável legal (guardian da 0028). */
export const PORTAL_AGINDO_COMO = ['titular', 'responsavel_legal'] as const;
export type PortalAgindoComo = (typeof PORTAL_AGINDO_COMO)[number];

/** Status da consulta no vocabulário do front (o backend traduz do banco). */
export const PORTAL_STATUS_CONSULTA = ['agendado', 'confirmado', 'chegou', 'em_atendimento', 'atendido', 'faltou', 'cancelado'] as const;
export type PortalStatusConsulta = (typeof PORTAL_STATUS_CONSULTA)[number];

/** Formas de pagamento do financeiro (nomes do banco). */
export const PORTAL_FORMAS_DE_PAGAMENTO = ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix_manual', 'transferencia', 'convenio'] as const;
export type PortalFormaDePagamento = (typeof PORTAL_FORMAS_DE_PAGAMENTO)[number];

export const PORTAL_SITUACOES_DO_RECIBO = ['emitido', 'cancelado'] as const;
export type PortalSituacaoDoRecibo = (typeof PORTAL_SITUACOES_DO_RECIBO)[number];

/** Pedidos do titular (LGPD art. 18): o tipo CANÔNICO que o backend devolve. */
export const PORTAL_TIPOS_DE_PEDIDO = ['acesso', 'correcao', 'portabilidade', 'eliminacao', 'compartilhamento'] as const;
export type PortalTipoDePedido = (typeof PORTAL_TIPOS_DE_PEDIDO)[number];

/** Apelidos que o backend ACEITA na entrada (legado do front) e o canônico que ele grava e devolve. */
export const PORTAL_APELIDOS_DE_PEDIDO = {
  acesso: 'acesso',
  ver_dados: 'acesso',
  correcao: 'correcao',
  corrigir: 'correcao',
  portabilidade: 'portabilidade',
  baixar: 'portabilidade',
  eliminacao: 'eliminacao',
  apagar: 'eliminacao',
  compartilhamento: 'compartilhamento',
} as const satisfies Readonly<Record<string, PortalTipoDePedido>>;
export type PortalTipoDePedidoAceito = keyof typeof PORTAL_APELIDOS_DE_PEDIDO;
export const PORTAL_TIPOS_DE_PEDIDO_ACEITOS = Object.keys(PORTAL_APELIDOS_DE_PEDIDO) as PortalTipoDePedidoAceito[];

export const PORTAL_SITUACOES_DO_PEDIDO = ['aberto', 'respondido'] as const;
export type PortalSituacaoDoPedido = (typeof PORTAL_SITUACOES_DO_PEDIDO)[number];

export const PORTAL_FINALIDADES = ['lembretes_whatsapp', 'escriba_ia', 'pesquisa'] as const;
export type PortalFinalidade = (typeof PORTAL_FINALIDADES)[number];

/** Estado atual do consentimento (3 estados: "não respondido" vale como NÃO). */
export const PORTAL_RESPOSTAS_CONSENTIMENTO = ['sim', 'nao', 'nao_respondido'] as const;
export type PortalRespostaConsentimento = (typeof PORTAL_RESPOSTAS_CONSENTIMENTO)[number];

/** Eventos do histórico (append-only): responder `sim`/`nao` ou `desfeito`. */
export const PORTAL_EVENTOS_CONSENTIMENTO = ['sim', 'nao', 'desfeito'] as const;
export type PortalEventoConsentimento = (typeof PORTAL_EVENTOS_CONSENTIMENTO)[number];

/** Estado de IA no vocabulário do escriba (só em `escriba_ia`; `nao_informado` nega). */
export const PORTAL_ESTADOS_IA = ['nao_informado', 'informado_nao_recusou', 'recusou'] as const;
export type PortalEstadoIa = (typeof PORTAL_ESTADOS_IA)[number];

/**
 * Nomes de campo que NUNCA podem aparecer em resposta do portal (titular ou responsável): conteúdo ou
 * categoria clínica. A especialidade do profissional também é proibida (revelaria psicologia/psiquiatria
 * do adolescente ao responsável).
 *
 * LIMITE (C5 da conferência de 24/10): a lista compara NOMES, não VALORES. Um campo neutro (`descricao`,
 * `profissional`, `emitente.nome`) pode carregar algo clínico no conteúdo. É um ALARME, não a barreira: quem
 * protege de fato é a conferência ESTRITA (`conferirForma`: campo novo = mudar o contrato e passar pelo
 * guardião) junto com o filtro no SERVIDOR (sigilo da 0037 + RLS) e a origem neutra dos valores.
 */
export const CAMPOS_CLINICOS_PROIBIDOS = [
  'especialidade',
  'areaSensivel',
  'diagnostico',
  'cid',
  'queixa',
  'anamnese',
  'evolucao',
  'conduta',
  'prescricao',
  'prontuario',
  'anotacao',
  'notaClinica',
  'observacaoClinica',
  'tipoDeAtendimento',
] as const;

// ------------------------------------------------------------------ formas (geram os tipos)

const Vinculo = f.obj({
  vinculoId: f.texto,
  clinica: f.texto,
  primeiroNome: f.texto,
  agindoComo: f.enumDe(PORTAL_AGINDO_COMO),
});

const DesafioDoConvite = f.obj({ canal: f.literal('sms'), destino: f.texto });

const Consulta = f.obj({
  id: f.texto,
  data: f.texto,
  hora: f.texto,
  profissional: f.texto,
  status: f.enumDe(PORTAL_STATUS_CONSULTA),
  /** Botões seguem ESTES flags (não o status). */
  podeConfirmar: f.bool,
  podeCancelar: f.bool,
});

const StatusDaConsulta = f.obj({ status: f.enumDe(PORTAL_STATUS_CONSULTA) });

const ReciboResumo = f.obj({
  id: f.texto,
  numero: f.inteiro,
  data: f.texto,
  valorCentavos: f.inteiro,
  forma: f.enumDe(PORTAL_FORMAS_DE_PAGAMENTO),
  situacao: f.enumDe(PORTAL_SITUACOES_DO_RECIBO),
});

const PessoaDoRecibo = f.obj({ nome: f.texto, cpf: f.ouNulo(f.texto) });

/** Retrato emitido (`ConteudoDoRecibo`) + id, número e situação. CPF de pagador terceiro vem mascarado. */
const Recibo = f.obj({
  id: f.texto,
  numero: f.inteiro,
  situacao: f.enumDe(PORTAL_SITUACOES_DO_RECIBO),
  versao: f.literal(1),
  emitente: f.obj({
    tipo: f.enumDe(['pf', 'pj'] as const),
    nome: f.texto,
    documento: f.ouNulo(f.texto),
    registroConselho: f.ouNulo(f.texto),
    // C3 (conferência de 24/10): o `profissionalId` do retrato (UUID interno) NÃO sai pelo portal.
  }),
  pagador: PessoaDoRecibo,
  beneficiario: PessoaDoRecibo,
  valorCentavos: f.inteiro,
  forma: f.enumDe(PORTAL_FORMAS_DE_PAGAMENTO),
  /** AAAA-MM-DD, fuso da clínica. */
  dataPagamento: f.texto,
  /** Texto neutro da clínica ("atendimento em saúde"); nunca diagnóstico ou especialidade. */
  descricao: f.texto,
  /** Ex.: `cpf_do_pagador`, `cpf_do_beneficiario`, `cpf_do_profissional`, `cnpj_da_clinica`, `pagador_responsavel`. */
  pendencias: f.lista(f.texto),
});

const Documentos = f.obj({ itens: f.vazia, disponivel: f.literal(false) });

/**
 * Rótulo da tela "meus dados": o titular vê `meus_dados`; o responsável legal vê `dados_do_paciente` (o
 * front mostra "dados de <primeiro nome do paciente>", nunca "seus dados": o cadastro é do paciente).
 */
export const PORTAL_ROTULOS_DOS_DADOS = ['meus_dados', 'dados_do_paciente'] as const;
export type PortalRotuloDosDados = (typeof PORTAL_ROTULOS_DOS_DADOS)[number];

/**
 * Cadastro do paciente. `nascimento` sai COMPLETO (`AAAA-MM-DD`) para o titular e para o responsável legal
 * (decisão C1 da conferência de 24/10: a data decide sigilo do adolescente, consentimento e fim da
 * representação; quem não a vê não pode pedir a correção). NÃO se edita pelo portal: muda só por
 * `POST /portal/meus-dados/correcao` (campo `nascimento`), analisado pela clínica.
 */
const MeusDados = f.obj({
  rotulo: f.enumDe(PORTAL_ROTULOS_DOS_DADOS),
  nome: f.texto,
  nomeSocial: f.ouNulo(f.texto),
  telefone: f.ouNulo(f.texto),
  cpfMascarado: f.ouNulo(f.texto),
  /** `AAAA-MM-DD`; null = a clínica não informou. */
  nascimento: f.ouNulo(f.data),
});

/**
 * Pedido de correção do cadastro. `nascimento` (opcional) é a data que o titular/responsável diz ser a
 * certa: a clínica analisa. Se ela REDUZIR a idade de paciente com 12 anos ou mais (pode tirá-lo do sigilo
 * do adolescente ou devolver a representação), a clínica só atende com conferência de documento.
 */
const CorrecaoDosDados = f.obj({ detalhe: f.texto, nascimento: f.opcional(f.data) });

const Pedido = f.obj({
  id: f.texto,
  /** Formato do servidor (AAAAMMDD-XXXXXXXX). Não recalcular. */
  protocolo: f.texto,
  tipo: f.enumDe(PORTAL_TIPOS_DE_PEDIDO),
  abertoEm: f.texto,
  /** Prazo do servidor (ISO). Não recalcular. */
  prazo: f.texto,
  situacao: f.enumDe(PORTAL_SITUACOES_DO_PEDIDO),
  resposta: f.ouNulo(f.texto),
});

/** O texto mostrado é o do SERVIDOR (título + explicação + versão): é o que o hash do evento prova. */
const Consentimento = f.obj({
  finalidade: f.enumDe(PORTAL_FINALIDADES),
  titulo: f.texto,
  explicacao: f.texto,
  resposta: f.enumDe(PORTAL_RESPOSTAS_CONSENTIMENTO),
  versaoTexto: f.texto,
  atualizadoEm: f.ouNulo(f.texto),
  estadoIa: f.opcional(f.enumDe(PORTAL_ESTADOS_IA)),
});

const RespostaDoConsentimento = f.obj({ resposta: f.enumDe(PORTAL_RESPOSTAS_CONSENTIMENTO) });

const EventoDoHistorico = f.obj({
  resposta: f.enumDe(PORTAL_EVENTOS_CONSENTIMENTO),
  em: f.texto,
  canal: f.literal('portal'),
  agindoComo: f.enumDe(PORTAL_AGINDO_COMO),
  versaoTexto: f.texto,
});

/** Corpo de erro da API: só código estável, nunca valor de campo. */
export const FormaErroDaApi = f.obj({
  statusCode: f.inteiro,
  message: f.texto,
  codigo: f.opcional(f.texto),
  campos: f.opcional(f.lista(f.texto)),
});
export type ErroDaApi = Infer<typeof FormaErroDaApi>;

export type VinculoDaConta = Infer<typeof Vinculo>;
export type DesafioDoConvitePortal = Infer<typeof DesafioDoConvite>;
export type ConsultaPortal = Infer<typeof Consulta>;
export type ReciboPortalResumo = Infer<typeof ReciboResumo>;
export type ReciboPortal = Infer<typeof Recibo>;
export type MeusDadosPortal = Infer<typeof MeusDados>;
export type PedidoPortal = Infer<typeof Pedido>;
export type ConsentimentoPortal = Infer<typeof Consentimento>;
export type EventoDeConsentimentoPortal = Infer<typeof EventoDoHistorico>;

// ------------------------------------------------------------------ rotas

const SEM_CORPO = f.obj({});

interface Erro {
  readonly status: 400 | 401 | 403 | 404 | 409 | 429;
  readonly codigo?: string;
}

interface DefinicaoDeRota {
  readonly metodo: 'GET' | 'POST';
  readonly caminho: string;
  readonly sucesso: 200 | 201;
  /** Corpo da requisição (`null` = GET, sem corpo e sem query). */
  readonly corpo: Forma | null;
  readonly resposta: Forma;
  /** Erros ESPECÍFICOS da rota (os comuns estão em `PORTAL_ERROS_COMUNS`). */
  readonly erros: readonly Erro[];
  /** Precisa de vínculo escolhido na sessão (senão 409 `escolher_vinculo`/`sem_vinculo`). */
  readonly noVinculo: boolean;
}

/** Erros que qualquer rota do portal pode devolver. */
export const PORTAL_ERROS_COMUNS = [
  { status: 400, codigo: undefined, quando: 'query em GET, corpo com campo a mais ou inválido (`campos` = nomes)' },
  { status: 401, codigo: undefined, quando: 'sem sessão do portal (a sessão da clínica não serve)' },
  { status: 429, codigo: 'limite_por_usuario', quando: 'limite de requisições por conta (Retry-After)' },
] as const;

/** Erros de toda rota que abre o vínculo (`noVinculo: true`). */
export const PORTAL_ERROS_DO_VINCULO = [
  { status: 409, codigo: 'escolher_vinculo', quando: 'a conta tem mais de um vínculo e não escolheu (POST /portal/sessao/vinculo)' },
  { status: 409, codigo: 'sem_vinculo', quando: 'a conta ainda não resgatou nenhum convite' },
  { status: 403, codigo: 'vinculo_inativo', quando: 'vínculo revogado, paciente inativo ou fim da representação' },
  { status: 403, codigo: 'janela_de_saida_encerrada', quando: 'clínica cancelada fora da janela de saída' },
] as const;

const ERROS_DA_CONSULTA = [
  { status: 404 },
  { status: 409, codigo: 'status_nao_permite' },
  { status: 409, codigo: 'consulta_ja_comecou' },
  { status: 403, codigo: 'assinatura_bloqueia_escrita' },
] as const satisfies readonly Erro[];

const ERROS_DO_PEDIDO = [
  { status: 409, codigo: 'clinica_sem_chave_de_dados' },
  { status: 429, codigo: 'limite_diario_de_pedidos' },
] as const satisfies readonly Erro[];

const ERROS_DO_CONSENTIMENTO = [
  { status: 409, codigo: 'consentimento_pelo_responsavel' },
  { status: 409, codigo: 'nascimento_nao_informado' },
] as const satisfies readonly Erro[];

export const CONTRATO_PORTAL = {
  'GET /portal/vinculos': {
    metodo: 'GET', caminho: '/portal/vinculos', sucesso: 200, corpo: null, noVinculo: false,
    resposta: f.lista(Vinculo), erros: [],
  },
  'GET /portal/sessao': {
    metodo: 'GET', caminho: '/portal/sessao', sucesso: 200, corpo: null, noVinculo: true,
    resposta: Vinculo, erros: [],
  },
  'POST /portal/sessao/vinculo': {
    metodo: 'POST', caminho: '/portal/sessao/vinculo', sucesso: 200, corpo: f.obj({ vinculoId: f.texto }), noVinculo: false,
    resposta: Vinculo, erros: [{ status: 404 }],
  },
  'POST /portal/convites/resgate': {
    metodo: 'POST', caminho: '/portal/convites/resgate', sucesso: 200, corpo: f.obj({ token: f.texto }), noVinculo: false,
    resposta: DesafioDoConvite, erros: [{ status: 409, codigo: 'convite_invalido' }, { status: 429, codigo: 'limite_por_usuario' }],
  },
  'POST /portal/convites/resgate/confirmar': {
    metodo: 'POST', caminho: '/portal/convites/resgate/confirmar', sucesso: 200, corpo: f.obj({ token: f.texto, codigo: f.texto }), noVinculo: false,
    resposta: f.obj({ vinculoId: f.texto }), erros: [{ status: 409, codigo: 'convite_invalido' }],
  },
  'GET /portal/consultas': {
    metodo: 'GET', caminho: '/portal/consultas', sucesso: 200, corpo: null, noVinculo: true,
    resposta: f.lista(Consulta), erros: [],
  },
  'POST /portal/consultas/:id/confirmar': {
    metodo: 'POST', caminho: '/portal/consultas/:id/confirmar', sucesso: 200, corpo: SEM_CORPO, noVinculo: true,
    resposta: StatusDaConsulta, erros: ERROS_DA_CONSULTA,
  },
  'POST /portal/consultas/:id/desfazer-confirmacao': {
    metodo: 'POST', caminho: '/portal/consultas/:id/desfazer-confirmacao', sucesso: 200, corpo: SEM_CORPO, noVinculo: true,
    resposta: StatusDaConsulta, erros: ERROS_DA_CONSULTA,
  },
  'POST /portal/consultas/:id/cancelar': {
    metodo: 'POST', caminho: '/portal/consultas/:id/cancelar', sucesso: 200, corpo: SEM_CORPO, noVinculo: true,
    resposta: StatusDaConsulta, erros: [...ERROS_DA_CONSULTA, { status: 409, codigo: 'prazo_de_cancelamento_encerrado' }],
  },
  'GET /portal/recibos': {
    metodo: 'GET', caminho: '/portal/recibos', sucesso: 200, corpo: null, noVinculo: true,
    resposta: f.lista(ReciboResumo), erros: [],
  },
  'GET /portal/recibos/:id': {
    metodo: 'GET', caminho: '/portal/recibos/:id', sucesso: 200, corpo: null, noVinculo: true,
    resposta: Recibo, erros: [{ status: 404 }, { status: 409, codigo: 'recibo_eliminado_por_retencao_fiscal' }],
  },
  'GET /portal/documentos': {
    metodo: 'GET', caminho: '/portal/documentos', sucesso: 200, corpo: null, noVinculo: true,
    resposta: Documentos, erros: [],
  },
  'GET /portal/meus-dados': {
    metodo: 'GET', caminho: '/portal/meus-dados', sucesso: 200, corpo: null, noVinculo: true,
    resposta: MeusDados, erros: [],
  },
  'POST /portal/meus-dados/correcao': {
    metodo: 'POST', caminho: '/portal/meus-dados/correcao', sucesso: 201, corpo: CorrecaoDosDados, noVinculo: true,
    resposta: Pedido, erros: ERROS_DO_PEDIDO,
  },
  'GET /portal/solicitacoes': {
    metodo: 'GET', caminho: '/portal/solicitacoes', sucesso: 200, corpo: null, noVinculo: true,
    resposta: f.lista(Pedido), erros: [],
  },
  'POST /portal/solicitacoes': {
    metodo: 'POST', caminho: '/portal/solicitacoes', sucesso: 201,
    corpo: f.obj({ tipo: f.enumDe(PORTAL_TIPOS_DE_PEDIDO_ACEITOS as readonly PortalTipoDePedidoAceito[]), detalhe: f.opcional(f.texto) }),
    noVinculo: true, resposta: Pedido, erros: ERROS_DO_PEDIDO,
  },
  'GET /portal/privacidade/consentimentos': {
    metodo: 'GET', caminho: '/portal/privacidade/consentimentos', sucesso: 200, corpo: null, noVinculo: true,
    resposta: f.lista(Consentimento), erros: [],
  },
  'POST /portal/privacidade/consentimentos/:finalidade': {
    metodo: 'POST', caminho: '/portal/privacidade/consentimentos/:finalidade', sucesso: 200,
    corpo: f.obj({ resposta: f.enumDe(['sim', 'nao'] as const) }), noVinculo: true,
    resposta: RespostaDoConsentimento, erros: ERROS_DO_CONSENTIMENTO,
  },
  'POST /portal/privacidade/consentimentos/:finalidade/desfazer': {
    metodo: 'POST', caminho: '/portal/privacidade/consentimentos/:finalidade/desfazer', sucesso: 200, corpo: SEM_CORPO, noVinculo: true,
    resposta: RespostaDoConsentimento, erros: [...ERROS_DO_CONSENTIMENTO, { status: 409, codigo: 'nada_a_desfazer' }],
  },
  'GET /portal/privacidade/consentimentos/:finalidade/historico': {
    metodo: 'GET', caminho: '/portal/privacidade/consentimentos/:finalidade/historico', sucesso: 200, corpo: null, noVinculo: true,
    resposta: f.lista(EventoDoHistorico), erros: [],
  },
} as const satisfies Readonly<Record<string, DefinicaoDeRota>>;

/** Nome de rota (`'GET /portal/consultas'` etc.). */
export type RotaPortal = keyof typeof CONTRATO_PORTAL;
/** Resposta de sucesso da rota. */
export type RespostaPortal<R extends RotaPortal> = Infer<(typeof CONTRATO_PORTAL)[R]['resposta']>;
/** Corpo da requisição da rota (`never` para GET). */
export type CorpoPortal<R extends RotaPortal> = (typeof CONTRATO_PORTAL)[R]['corpo'] extends infer C extends Forma ? Infer<C> : never;

/** O contrato inteiro, rota a rota: o front tipa o adaptador HTTP com isto. */
export type ApiPortal = {
  readonly [R in RotaPortal]: { readonly corpo: CorpoPortal<R>; readonly resposta: RespostaPortal<R> };
};

/** Confere a resposta REAL de uma rota contra o contrato (teste de contrato; vazio = confere). */
export function conferirRespostaPortal(rota: RotaPortal, corpo: unknown): string[] {
  return conferirForma(CONTRATO_PORTAL[rota].resposta, corpo);
}

/** Campos clínicos proibidos que aparecem em alguma resposta do contrato (deve ser sempre vazio). */
export function camposClinicosNoContrato(): string[] {
  const proibidos = new Set<string>(CAMPOS_CLINICOS_PROIBIDOS);
  const achados = new Set<string>();
  for (const def of Object.values(CONTRATO_PORTAL) as readonly DefinicaoDeRota[]) {
    for (const k of chavesDaForma(def.resposta as Forma | FormaOpcional)) if (proibidos.has(k)) achados.add(k);
  }
  return [...achados];
}

/** Monta o caminho com os parâmetros (ex.: `caminhoPortal('POST /portal/consultas/:id/confirmar', { id })`). */
export function caminhoPortal(rota: RotaPortal, params: Readonly<Record<string, string>> = {}): string {
  return CONTRATO_PORTAL[rota].caminho.replace(/:([a-z]+)/g, (_, nome: string) => {
    const v = params[nome];
    if (v === undefined) throw new Error(`parâmetro ausente: ${nome}`);
    return encodeURIComponent(v);
  });
}
