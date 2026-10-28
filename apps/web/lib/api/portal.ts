/**
 * Contrato do PORTAL DO PACIENTE (veto B3 do Guardião). É separado do contrato da clínica:
 * - nenhum método recebe `pacienteId`: o servidor descobre o titular pela sessão;
 * - só existem ações do próprio paciente; cada uma confere no servidor se a consulta é dele;
 * - nada de lista de pacientes, agenda da clínica ou usuário da equipe.
 */

export type RespostaConsentimento = 'sim' | 'nao' | 'nao_respondido';

export interface ConsultaPortal {
  id: string;
  data: string;
  hora: string;
  profissional: string;
  status: 'agendado' | 'confirmado' | 'cancelado';
}

export interface ReciboPortal {
  id: string;
  data: string;
  valor: number;
  forma: 'dinheiro' | 'cartao' | 'pix';
  /** Texto pronto do recibo (nome de registro e CPF entram porque o recibo serve ao IR). */
  texto: string;
}

export interface MeusDados {
  nome: string;
  nomeSocial?: string;
  telefone: string;
  cpfMascarado: string;
}

export interface EventoConsentimento {
  resposta: 'sim' | 'nao' | 'desfeito';
  em: string;
  canal: 'portal';
}

export interface PedidoPortal {
  protocolo: string;
  tipo: 'ver_dados' | 'corrigir' | 'baixar' | 'apagar' | 'compartilhamento';
  abertoEm: string;
  prazo: string;
  situacao: 'aberto' | 'respondido';
}

export interface ApiPortal {
  primeiroNome(): Promise<string>;
  minhasConsultas(): Promise<ConsultaPortal[]>;
  confirmarPresenca(agendamentoId: string): Promise<void>;
  avisarAusencia(agendamentoId: string): Promise<void>;
  /** Desfaz a última resposta do próprio paciente nessa consulta. */
  desfazerResposta(agendamentoId: string): Promise<void>;
  meusRecibos(): Promise<ReciboPortal[]>;
  meusDados(): Promise<MeusDados>;
  meusConsentimentos(): Promise<Record<string, RespostaConsentimento>>;
  /** Consentimento é histórico (append-only): responder e desfazer GRAVAM eventos novos. */
  responderConsentimento(id: string, r: 'sim' | 'nao'): Promise<void>;
  desfazerConsentimento(id: string): Promise<void>;
  historicoConsentimento(id: string): Promise<EventoConsentimento[]>;
  abrirPedido(tipo: PedidoPortal['tipo'], detalhe?: string): Promise<PedidoPortal>;
  meusPedidos(): Promise<PedidoPortal[]>;
}
