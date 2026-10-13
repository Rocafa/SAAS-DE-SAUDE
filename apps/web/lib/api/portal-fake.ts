/**
 * Adaptador FAKE do portal. Simula o SERVIDOR: a "sessão" do paciente fica aqui dentro e nunca
 * sai para a tela. Os dados vêm do mesmo banco fictício da clínica, mas só o que é do titular.
 */
import { cpfMascarado } from '../ajudante/busca';
import { paraIsoLocal } from '../ajudante/datas';
import { prazoResposta, protocolo } from '../portal';
import { criarApiFake, PROFISSIONAIS_FICTICIOS } from './fake';
import type { ApiPortal, EventoConsentimento, PedidoPortal, RespostaConsentimento } from './portal';
import type { StatusAgendamento } from './tipos';

const FORMA = { pix: 'Pix', cartao: 'cartão', dinheiro: 'dinheiro' } as const;

export function criarApiPortalFake(opcoes: { agora?: Date } = {}): ApiPortal {
  const agora = opcoes.agora ?? new Date();
  const hoje = paraIsoLocal(agora);
  const banco = criarApiFake({ agora });
  // Sessão de demonstração: a paciente fictícia Maria Silva. Só o "servidor" conhece.
  const sessao = 'p01';
  const respostasConsulta = new Map<string, StatusAgendamento[]>();
  const consentimentos: Record<string, EventoConsentimento[]> = {
    lembretes_whatsapp: [{ resposta: 'sim', em: hoje, canal: 'portal' }],
    pesquisa: [{ resposta: 'nao', em: hoje, canal: 'portal' }],
  };
  const pedidos: PedidoPortal[] = [];

  async function minhaConsulta(id: string) {
    const a = (await banco.listarAgendamentos({ pacienteId: sessao })).find((x) => x.id === id);
    // Mesma resposta para "não existe" e "não é sua": não revela consulta de outra pessoa.
    if (!a || a.data < hoje) throw new Error('Consulta não encontrada.');
    return a;
  }
  async function responder(id: string, status: StatusAgendamento) {
    const a = await minhaConsulta(id);
    if (a.status !== 'agendado' && a.status !== 'confirmado') throw new Error('Essa consulta não pode mais ser alterada por aqui. Fale com a clínica.');
    const anterior = await banco.alterarStatus(id, status);
    respostasConsulta.set(id, [...(respostasConsulta.get(id) ?? []), anterior]);
  }
  function estado(eventos: EventoConsentimento[] | undefined): RespostaConsentimento {
    const pilha: ('sim' | 'nao')[] = [];
    for (const e of eventos ?? []) {
      if (e.resposta === 'desfeito') pilha.pop();
      else pilha.push(e.resposta);
    }
    return pilha.at(-1) ?? 'nao_respondido';
  }

  return {
    async primeiroNome() {
      const p = await banco.obterPaciente(sessao);
      return (p?.nomeSocial ?? p?.nome ?? '').split(' ')[0] ?? '';
    },
    async minhasConsultas() {
      const ags = await banco.listarAgendamentos({ pacienteId: sessao, de: hoje });
      return ags
        .filter((a) => a.status === 'agendado' || a.status === 'confirmado' || a.status === 'cancelado')
        .map((a) => ({
          id: a.id,
          data: a.data,
          hora: a.hora,
          profissional: PROFISSIONAIS_FICTICIOS.find((p) => p.id === a.profissionalId)?.nome ?? '',
          status: a.status as 'agendado' | 'confirmado' | 'cancelado',
        }));
    },
    confirmarPresenca: (id) => responder(id, 'confirmado'),
    avisarAusencia: (id) => responder(id, 'cancelado'),
    async desfazerResposta(id) {
      await minhaConsulta(id);
      const pilha = respostasConsulta.get(id) ?? [];
      const anterior = pilha.pop();
      if (anterior) await banco.alterarStatus(id, anterior);
    },
    async meusRecibos() {
      const p = await banco.obterPaciente(sessao);
      return (await banco.listarRecibos(sessao)).map((r) => ({
        id: r.id,
        data: r.data,
        valor: r.valor,
        forma: r.forma,
        texto: `Recebi de ${p?.nome ?? ''}${p?.cpf ? `, CPF ${p.cpf}` : ''}, a quantia de ${r.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}, referente a atendimento em saúde, pago em ${FORMA[r.forma]}.`,
      }));
    },
    async meusDados() {
      const p = await banco.obterPaciente(sessao);
      if (!p) throw new Error('Não achamos seu cadastro. Fale com a clínica.');
      return { nome: p.nome, ...(p.nomeSocial ? { nomeSocial: p.nomeSocial } : {}), telefone: p.telefone, cpfMascarado: cpfMascarado(p.cpf) };
    },
    async meusConsentimentos() {
      return {
        lembretes_whatsapp: estado(consentimentos.lembretes_whatsapp),
        escriba_ia: estado(consentimentos.escriba_ia),
        pesquisa: estado(consentimentos.pesquisa),
      };
    },
    async responderConsentimento(id, r) {
      consentimentos[id] = [...(consentimentos[id] ?? []), { resposta: r, em: hoje, canal: 'portal' }];
    },
    async desfazerConsentimento(id) {
      consentimentos[id] = [...(consentimentos[id] ?? []), { resposta: 'desfeito', em: hoje, canal: 'portal' }];
    },
    historicoConsentimento: async (id) => [...(consentimentos[id] ?? [])],
    async abrirPedido(tipo, detalhe) {
      if (tipo === 'corrigir' && !detalhe?.trim()) throw new Error('Escreva o que está errado e como deve ficar.');
      const p: PedidoPortal = { protocolo: protocolo(hoje, pedidos.length + 1), tipo, abertoEm: hoje, prazo: prazoResposta(hoje), situacao: 'aberto' };
      pedidos.push(p);
      return p;
    },
    meusPedidos: async () => [...pedidos],
  };
}
