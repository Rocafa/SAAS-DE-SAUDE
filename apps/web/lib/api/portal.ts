/**
 * Cliente do PORTAL DO PACIENTE (veto B3 do Guardião). Os formatos vêm do contrato ÚNICO `ApiPortal`
 * de `@plataforma/shared` (`packages/shared/src/api-portal.ts`, publicado pelo backend no #73; P1 do
 * parecer de 24/10): nada de cópia local de tipo. Este arquivo só dá nomes de método às rotas.
 *
 * - nenhum método recebe id de paciente ou de clínica: o servidor tira o titular da SESSÃO do portal;
 * - "de quem" é o acesso sai do vínculo escolhido na sessão (`agindoComo`: titular ou responsável legal);
 * - titular e responsável recebem os mesmos formatos e nenhum é clínico (prontuário não sai pelo portal);
 * - o que o servidor decide (botões, protocolo, prazo, texto do consentimento) vem pronto: o front não recalcula.
 *
 * Adaptadores: `portal-fake.ts` (padrão, demonstração) e `portal-http.ts` (API real; só em dev até a D4).
 * Nenhum dos dois importa o contrato, o fake ou o cliente HTTP da clínica (R-47a), salvo o fake, que
 * simula o servidor com o banco fictício.
 */
import type { PortalTipoDePedido, RespostaPortal } from '@plataforma/shared';

export type {
  ConsentimentoPortal,
  ConsultaPortal,
  DesafioDoConvitePortal,
  EventoDeConsentimentoPortal,
  MeusDadosPortal,
  PedidoPortal,
  PortalAgindoComo,
  PortalFinalidade,
  PortalFormaDePagamento,
  PortalRespostaConsentimento,
  PortalStatusConsulta,
  PortalTipoDePedido,
  ReciboPortal,
  ReciboPortalResumo,
  VinculoDaConta,
} from '@plataforma/shared';

/** Método do cliente → rota do contrato. Um teste confere que toda rota tem método. */
export const ROTAS = {
  vinculos: 'GET /portal/vinculos',
  escolherVinculo: 'POST /portal/sessao/vinculo',
  sessao: 'GET /portal/sessao',
  resgatarConvite: 'POST /portal/convites/resgate',
  confirmarConvite: 'POST /portal/convites/resgate/confirmar',
  consultas: 'GET /portal/consultas',
  confirmarConsulta: 'POST /portal/consultas/:id/confirmar',
  desfazerConfirmacao: 'POST /portal/consultas/:id/desfazer-confirmacao',
  cancelarConsulta: 'POST /portal/consultas/:id/cancelar',
  recibos: 'GET /portal/recibos',
  recibo: 'GET /portal/recibos/:id',
  documentos: 'GET /portal/documentos',
  meusDados: 'GET /portal/meus-dados',
  pedirCorrecao: 'POST /portal/meus-dados/correcao',
  pedidos: 'GET /portal/solicitacoes',
  abrirPedido: 'POST /portal/solicitacoes',
  consentimentos: 'GET /portal/privacidade/consentimentos',
  responderConsentimento: 'POST /portal/privacidade/consentimentos/:finalidade',
  desfazerConsentimento: 'POST /portal/privacidade/consentimentos/:finalidade/desfazer',
  historicoConsentimento: 'GET /portal/privacidade/consentimentos/:finalidade/historico',
} as const;

type R<K extends keyof typeof ROTAS> = RespostaPortal<(typeof ROTAS)[K]>;

export interface ClientePortal {
  vinculos(): Promise<R<'vinculos'>>;
  /** Troca o vínculo NA SESSÃO do servidor. Quem chama descarta todo o estado do portal. */
  escolherVinculo(vinculoId: string): Promise<R<'escolherVinculo'>>;
  sessao(): Promise<R<'sessao'>>;
  /** Passo 1 do convite: o código vai ao telefone DO CADASTRO; volta só o destino mascarado. */
  resgatarConvite(token: string): Promise<R<'resgatarConvite'>>;
  confirmarConvite(token: string, codigo: string): Promise<R<'confirmarConvite'>>;
  consultas(): Promise<R<'consultas'>>;
  confirmarConsulta(id: string): Promise<R<'confirmarConsulta'>>;
  /** Só desfaz CONFIRMAÇÃO: cancelamento não se desfaz pelo portal (fala com a clínica). */
  desfazerConfirmacao(id: string): Promise<R<'desfazerConfirmacao'>>;
  cancelarConsulta(id: string): Promise<R<'cancelarConsulta'>>;
  recibos(): Promise<R<'recibos'>>;
  /** Detalhe só por ação do usuário (imprimir): não pré-carregar nem guardar. */
  recibo(id: string): Promise<R<'recibo'>>;
  documentos(): Promise<R<'documentos'>>;
  meusDados(): Promise<R<'meusDados'>>;
  /** Único caminho para mudar o cadastro (inclusive a data de nascimento): vira pedido para a clínica. */
  pedirCorrecao(dados: { detalhe: string; nascimento?: string }): Promise<R<'pedirCorrecao'>>;
  pedidos(): Promise<R<'pedidos'>>;
  abrirPedido(tipo: PortalTipoDePedido, detalhe?: string): Promise<R<'abrirPedido'>>;
  consentimentos(): Promise<R<'consentimentos'>>;
  responderConsentimento(finalidade: string, resposta: 'sim' | 'nao'): Promise<R<'responderConsentimento'>>;
  desfazerConsentimento(finalidade: string): Promise<R<'desfazerConsentimento'>>;
  historicoConsentimento(finalidade: string): Promise<R<'historicoConsentimento'>>;
}

/**
 * Erro do portal: só o status HTTP, o `codigo` estável do servidor e os NOMES dos campos inválidos.
 * Nunca carrega valor de campo nem corpo de resposta (pode ser dado pessoal).
 */
export class ErroPortal extends Error {
  readonly status: number;
  readonly codigo: string | undefined;
  readonly campos: readonly string[];
  constructor(status: number, codigo?: string, campos: readonly string[] = []) {
    super(mensagemDoErro(status, codigo));
    this.name = 'ErroPortal';
    this.status = status;
    this.codigo = codigo;
    this.campos = campos;
  }
}

const POR_CODIGO: Record<string, string> = {
  escolher_vinculo: 'Escolha de quem são os dados que você quer ver.',
  sem_vinculo: 'Você ainda não tem acesso a nenhum cadastro. Abra o link do convite que a clínica mandou.',
  vinculo_inativo: 'Este acesso não vale mais. Se precisar, peça um novo convite à clínica.',
  janela_de_saida_encerrada: 'O acesso pela internet a esta clínica foi encerrado. Fale com a clínica.',
  convite_invalido: 'Não deu para usar este convite. Confira o código ou peça um novo convite à clínica.',
  status_nao_permite: 'Essa consulta não pode mais ser alterada por aqui. Fale com a clínica.',
  consulta_ja_comecou: 'Essa consulta já começou. Fale com a clínica.',
  prazo_de_cancelamento_encerrado: 'Já passou o prazo para avisar pelo portal. Fale com a clínica pelo telefone ou WhatsApp.',
  assinatura_bloqueia_escrita: 'A clínica não está aceitando mudanças pelo portal agora. Fale com a clínica.',
  recibo_eliminado_por_retencao_fiscal: 'Este recibo passou do prazo de guarda e foi apagado. Se precisar de uma cópia, fale com a clínica.',
  clinica_sem_chave_de_dados: 'A clínica ainda não está pronta para receber pedidos pelo portal. Fale com a clínica.',
  limite_diario_de_pedidos: 'Você chegou ao limite de pedidos de hoje. Tente de novo amanhã.',
  limite_por_usuario: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.',
  consentimento_pelo_responsavel:
    'Pela lei (LGPD, art. 14), para quem tem menos de 18 anos quem autoriza é a mãe, o pai ou o responsável legal. Peça a ele para responder pelo portal.',
  nascimento_nao_informado:
    'A clínica ainda não tem a data de nascimento no cadastro, e ela decide quem pode autorizar (LGPD, art. 14). Peça a correção em "Meus dados".',
  nada_a_desfazer: 'Não há resposta para desfazer.',
};

/** Frase da tela para falha que não veio do servidor (configuração, rede, bug). */
export const MENSAGEM_GENERICA = 'O portal não está disponível agora. Tente de novo mais tarde ou fale com a clínica.';

/**
 * Erro → texto da tela (R3 do parecer do #75). `ErroPortal` já tem frase pensada para o paciente.
 * Qualquer outro erro (ex.: `lerConfigPortal` citando variável de ambiente) vira frase genérica: o
 * detalhe interno só aparece em desenvolvimento (`NODE_ENV === 'development'`), nunca no build de produção.
 */
export function mensagemParaTela(e: unknown, generica: string = MENSAGEM_GENERICA, ambiente: string | undefined = process.env.NODE_ENV): string {
  if (e instanceof ErroPortal) return e.message;
  if (ambiente === 'development' && e instanceof Error && e.message) return `${generica} [dev: ${e.message}]`;
  return generica;
}

/** Mensagem para a tela. Mesma frase para "não existe" e "não é sua" (404), sem revelar nada. */
export function mensagemDoErro(status: number, codigo?: string): string {
  if (codigo && POR_CODIGO[codigo]) return POR_CODIGO[codigo];
  switch (status) {
    case 400:
    case 422:
      return 'Confira o que você preencheu e tente de novo.';
    case 401:
      return 'Sua sessão terminou. Entre de novo no portal.';
    case 403:
      return 'Você não tem acesso a isto pelo portal. Fale com a clínica.';
    case 404:
      return 'Não encontramos o que você procurou.';
    case 409:
      return 'Não deu para fazer isso agora. Atualize a página e tente de novo.';
    case 429:
      return POR_CODIGO.limite_por_usuario!;
    default:
      return 'Não conseguimos falar com a clínica agora. Confira a internet e tente de novo.';
  }
}
