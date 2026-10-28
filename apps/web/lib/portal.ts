/**
 * Portal do paciente: textos e regras de EXIBIÇÃO (direitos do titular, LGPD art. 18; consentimentos).
 * Quem responde aos pedidos é a CLÍNICA (controladora). Protocolo, prazo, botões das consultas e o
 * texto do consentimento vêm do SERVIDOR (contrato `ApiPortal`): aqui só se traduz para a tela.
 */
import { ehDataAAAAMMDD, type MeusDadosPortal, type PortalFormaDePagamento, type PortalRespostaConsentimento, type PortalTipoDePedido } from '@plataforma/shared';

/** Prazo que a plataforma dá à clínica (só para o texto; a data do prazo vem do servidor). */
export const PRAZO_RESPOSTA_DIAS = 15;

type Direito = { tipo: PortalTipoDePedido; titulo: string; explicacao: string };

/**
 * Pedidos com os nomes CANÔNICOS do backend (P8). `correcao` vai para a tela de dados (pedido próprio).
 * Responsável legal (R1 do parecer do #75): os dados são do PACIENTE, então o texto fala dele
 * ("sobre Sofia", "dados de Sofia"), nunca "sobre mim"/"meus dados" (mesma lógica da C1-c).
 */
export function direitosDoVinculo(paciente?: string): Direito[] {
  const sobre = paciente ? `sobre ${paciente}` : 'sobre mim';
  const copia = paciente ? `dos dados de ${paciente}` : 'dos meus dados';
  const compartilhados = paciente ? `os dados de ${paciente} são compartilhados` : 'meus dados são compartilhados';
  return [
    { tipo: 'acesso', titulo: `Ver quais dados a clínica tem ${sobre}`, explicacao: 'Você recebe a lista do que está guardado e para quê.' },
    { tipo: 'correcao', titulo: 'Corrigir um dado errado', explicacao: 'Telefone, data de nascimento, nome social ou outro dado que mudou.' },
    { tipo: 'portabilidade', titulo: `Baixar uma cópia ${copia}`, explicacao: 'Em arquivo aberto, para levar a outro profissional se quiser.' },
    {
      tipo: 'eliminacao',
      titulo: 'Pedir para apagar dados',
      explicacao: 'A clínica apaga o que não for obrigatório. O prontuário fica guardado pelo prazo da lei (ex.: 20 anos para o CFM).',
    },
    { tipo: 'compartilhamento', titulo: `Saber com quem ${compartilhados}`, explicacao: 'Por exemplo, convênio ou laboratório.' },
  ];
}

/** Textos do próprio paciente (sem vínculo de responsável). */
export const DIREITOS: Direito[] = direitosDoVinculo();

export function tituloDoPedido(tipo: PortalTipoDePedido, paciente?: string): string {
  return direitosDoVinculo(paciente).find((d) => d.tipo === tipo)?.titulo ?? 'Pedido';
}

/**
 * Ajusta a mensagem ao vínculo: para o responsável o menu se chama "Dados do paciente", não
 * "Meus dados" (R1 do #75). Só troca o nome do menu; o resto é a frase do código do servidor.
 */
export function mensagemNoVinculo(mensagem: string, responsavel: boolean): string {
  return responsavel ? mensagem.replaceAll('"Meus dados"', '"Dados do paciente"') : mensagem;
}

/** Três estados (ressalva R1 do Guardião): "não respondido" vale como NÃO. */
export type Resposta = PortalRespostaConsentimento;

export const TEXTO_RESPOSTA: Record<Resposta, string> = {
  sim: 'Você aceitou',
  nao: 'Você recusou',
  nao_respondido: 'Ainda não respondido (vale como não)',
};

export function permitido(r: Resposta | undefined): boolean {
  return r === 'sim';
}

/** Formas de pagamento com os nomes do banco (P7). */
export const NOME_FORMA_PORTAL: Record<PortalFormaDePagamento, string> = {
  dinheiro: 'dinheiro',
  cartao_credito: 'cartão de crédito',
  cartao_debito: 'cartão de débito',
  pix_manual: 'Pix',
  transferencia: 'transferência',
  convenio: 'convênio',
};

/** Centavos (inteiro, como vem do servidor) → "R$ 150,00". */
export function centavosEmReais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** `AAAA-MM-DD` → `DD/MM/AAAA` (sem fuso: data de calendário). */
export function dataBr(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/** Prazo do pedido (instante ISO do servidor) → data local `DD/MM/AAAA`. Não recalcula nada. */
export function prazoBr(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return dataBr(iso);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-BR');
}

/**
 * Título da tela de dados. Responsável legal: "Dados de <primeiro nome>", nunca "seus dados"
 * (o cadastro é do paciente; §10h).
 */
export function tituloDosDados(rotulo: MeusDadosPortal['rotulo'], primeiroNome: string): string {
  return rotulo === 'dados_do_paciente' ? `Dados de ${primeiroNome}` : 'Meus dados';
}

/** Mesma regra do servidor para o pedido de correção (detalhe ≥ 3; data existente, não futura, desde 1900). */
export function validarCorrecao(detalhe: string, nascimento: string | undefined, hoje: string): string | null {
  if (detalhe.trim().length < 3) return 'Escreva o que está errado e como deve ficar.';
  if (nascimento) {
    if (!ehDataAAAAMMDD(nascimento)) return 'Data de nascimento inválida.';
    if (nascimento > hoje || nascimento < '1900-01-01') return 'Confira a data de nascimento.';
  }
  return null;
}
