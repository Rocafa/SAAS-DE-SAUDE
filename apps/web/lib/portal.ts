/**
 * Portal do paciente: direitos do titular (LGPD art. 18) e consentimentos, em palavras do dia a dia.
 * Quem responde aos pedidos é a CLÍNICA (controladora); a plataforma só registra e conta o prazo.
 */
import { deIsoLocal, paraIsoLocal, somarDias } from './ajudante/datas';

/** Prazo que a plataforma dá à clínica para responder (o checklist LGPD usa 15 dias). */
export const PRAZO_RESPOSTA_DIAS = 15;

export type TipoPedido = 'ver_dados' | 'corrigir' | 'baixar' | 'apagar' | 'compartilhamento';

export const DIREITOS: { tipo: TipoPedido; titulo: string; explicacao: string }[] = [
  { tipo: 'ver_dados', titulo: 'Ver quais dados a clínica tem sobre mim', explicacao: 'Você recebe a lista do que está guardado e para quê.' },
  { tipo: 'corrigir', titulo: 'Corrigir um dado errado', explicacao: 'Telefone, endereço, nome social ou outro dado que mudou.' },
  { tipo: 'baixar', titulo: 'Baixar uma cópia dos meus dados', explicacao: 'Em arquivo aberto, para levar a outro profissional se quiser.' },
  {
    tipo: 'apagar',
    titulo: 'Pedir para apagar dados',
    explicacao: 'A clínica apaga o que não for obrigatório. O prontuário fica guardado pelo prazo da lei (ex.: 20 anos para o CFM).',
  },
  { tipo: 'compartilhamento', titulo: 'Saber com quem meus dados são compartilhados', explicacao: 'Por exemplo, convênio ou laboratório.' },
];

/** Três estados (ressalva R1 do Guardião): "não respondido" vale como NÃO. */
export type Resposta = 'sim' | 'nao' | 'nao_respondido';

export const CONSENTIMENTOS: { id: string; titulo: string; explicacao: string }[] = [
  { id: 'lembretes_whatsapp', titulo: 'Lembretes de consulta pelo WhatsApp', explicacao: 'Avisos de dia e hora. Nunca mandamos informação de saúde na mensagem.' },
  {
    id: 'escriba_ia',
    titulo: 'Uso de inteligência artificial para escrever o rascunho da consulta',
    explicacao: 'O profissional sempre revisa antes de assinar. Você pode recusar e o atendimento é igual.',
  },
  { id: 'pesquisa', titulo: 'Pesquisa de satisfação depois da consulta', explicacao: 'Uma pergunta rápida por mensagem.' },
];

export function permitido(r: Resposta | undefined): boolean {
  return r === 'sim';
}

export function prazoResposta(abertoEm: string): string {
  return paraIsoLocal(somarDias(deIsoLocal(abertoEm), PRAZO_RESPOSTA_DIAS));
}

export function protocolo(abertoEm: string, seq: number): string {
  return `${abertoEm.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}

/** Na demonstração, o portal é sempre da paciente fictícia Maria Silva. */
export const PACIENTE_PORTAL = 'p01';
