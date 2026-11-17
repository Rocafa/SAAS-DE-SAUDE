/**
 * Adaptador FAKE do portal (padrão). Simula o SERVIDOR do contrato `ApiPortal`: a conta, os vínculos e
 * o vínculo escolhido ficam aqui dentro e nunca saem para a tela. Os dados vêm do banco fictício da
 * clínica, mas só o que é do paciente do vínculo escolhido. Erros com os MESMOS status e códigos do
 * backend (`ErroPortal`), para as telas tratarem igual nos dois modos.
 *
 * Conta de demonstração: Maria Silva (p01) como titular e responsável legal de Sofia Pinto (p24).
 */
import { ehDataAAAAMMDD, type PortalAgindoComo, type PortalFinalidade, type PortalTipoDePedido } from '@plataforma/shared';
import { cpfMascarado } from '../ajudante/busca';
import { deIsoLocal, paraIsoLocal } from '../ajudante/datas';
import { criarApiFake, PROFISSIONAIS_FICTICIOS } from './fake';
import {
  ErroPortal,
  type ClientePortal,
  type ConsentimentoPortal,
  type ConsultaPortal,
  type EventoDeConsentimentoPortal,
  type PedidoPortal,
  type PortalFormaDePagamento,
  type VinculoDaConta,
} from './portal';

/** Token do convite de demonstração (fictício; o real tem 256 bits e chega no `#fragmento` do link). */
export const TOKEN_CONVITE_DEMONSTRACAO = 'convite-de-demonstracao';
/** Código do convite de demonstração (só no fake; o real vai por SMS ao telefone do cadastro). */
export const CODIGO_CONVITE_DEMONSTRACAO = '123456';

const VERSAO_TEXTO = '2026-10-01';
const ANTECEDENCIA_CANCELAR_MS = 2 * 60 * 60 * 1000;

/** Textos que, no modo HTTP, vêm do servidor (é o que o hash do evento prova, R15). */
const TEXTOS_CONSENTIMENTO: Record<PortalFinalidade, { titulo: string; explicacao: string }> = {
  lembretes_whatsapp: { titulo: 'Lembretes de consulta pelo WhatsApp', explicacao: 'Avisos de dia e hora. Nunca mandamos informação de saúde na mensagem.' },
  escriba_ia: {
    titulo: 'Uso de inteligência artificial para escrever o rascunho da consulta',
    explicacao: 'O profissional sempre revisa antes de assinar. Você pode recusar e o atendimento é igual.',
  },
  pesquisa: { titulo: 'Pesquisa de satisfação depois da consulta', explicacao: 'Uma pergunta rápida por mensagem.' },
};
const FINALIDADES = Object.keys(TEXTOS_CONSENTIMENTO) as PortalFinalidade[];

const FORMA: Record<'pix' | 'cartao' | 'dinheiro', PortalFormaDePagamento> = { pix: 'pix_manual', cartao: 'cartao_credito', dinheiro: 'dinheiro' };

interface VinculoInterno {
  vinculoId: string;
  pacienteId: string;
  agindoComo: PortalAgindoComo;
}

export interface OpcoesPortalFake {
  agora?: Date;
  /** Vínculo já escolhido na sessão (padrão: o do titular). `null` = conta com vários e nenhum escolhido. */
  vinculoInicial?: 'titular' | 'responsavel' | null;
  /** Conta que ainda não resgatou nenhum convite. */
  semVinculos?: boolean;
}

export function criarApiPortalFake(opcoes: OpcoesPortalFake = {}): ClientePortal {
  const agora = opcoes.agora ?? new Date();
  const hoje = paraIsoLocal(agora);
  const banco = criarApiFake({ agora });
  const vinculos: VinculoInterno[] = opcoes.semVinculos
    ? []
    : [
        { vinculoId: 'v-titular', pacienteId: 'p01', agindoComo: 'titular' },
        { vinculoId: 'v-responsavel', pacienteId: 'p24', agindoComo: 'responsavel_legal' },
      ];
  const inicial = opcoes.vinculoInicial === undefined ? 'titular' : opcoes.vinculoInicial;
  let escolhido: VinculoInterno | null = inicial === null || opcoes.semVinculos ? null : (vinculos[inicial === 'titular' ? 0 : 1] ?? null);
  const consentimentos = new Map<string, Partial<Record<PortalFinalidade, EventoDeConsentimentoPortal[]>>>([
    [
      'v-titular',
      {
        lembretes_whatsapp: [{ resposta: 'sim', em: agora.toISOString(), canal: 'portal', agindoComo: 'titular', versaoTexto: VERSAO_TEXTO }],
        pesquisa: [{ resposta: 'nao', em: agora.toISOString(), canal: 'portal', agindoComo: 'titular', versaoTexto: VERSAO_TEXTO }],
      },
    ],
  ]);
  const pedidos = new Map<string, PedidoPortal[]>();
  let seqPedido = 0;

  function noVinculo(): VinculoInterno {
    if (!escolhido) throw new ErroPortal(409, vinculos.length === 0 ? 'sem_vinculo' : 'escolher_vinculo');
    return escolhido;
  }

  async function paraVinculo(v: VinculoInterno): Promise<VinculoDaConta> {
    const p = await banco.obterPaciente(v.pacienteId);
    return {
      vinculoId: v.vinculoId,
      clinica: 'Clínica Demonstração',
      primeiroNome: (p?.nomeSocial ?? p?.nome ?? '').split(' ')[0] ?? '',
      agindoComo: v.agindoComo,
    };
  }

  function inicio(a: { data: string; hora: string }): number {
    const [h, m] = a.hora.split(':').map(Number) as [number, number];
    const d = deIsoLocal(a.data);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  async function minhaConsulta(id: string) {
    const v = noVinculo();
    const a = (await banco.listarAgendamentos({ pacienteId: v.pacienteId })).find((x) => x.id === id);
    // Mesma resposta para "não existe" e "não é sua" (IDOR): 404 sem detalhe.
    if (!a || inicio(a) < agora.getTime() - ANTECEDENCIA_CANCELAR_MS) throw new ErroPortal(404);
    return a;
  }

  function estado(eventos: readonly EventoDeConsentimentoPortal[] | undefined): ConsentimentoPortal['resposta'] {
    const pilha: ('sim' | 'nao')[] = [];
    for (const e of eventos ?? []) {
      if (e.resposta === 'desfeito') pilha.pop();
      else pilha.push(e.resposta);
    }
    return pilha.at(-1) ?? 'nao_respondido';
  }

  function finalidadeValida(f: string): PortalFinalidade {
    if (!FINALIDADES.includes(f as PortalFinalidade)) throw new ErroPortal(404);
    return f as PortalFinalidade;
  }

  function novoPedido(tipo: PortalTipoDePedido): PedidoPortal {
    const v = noVinculo();
    seqPedido += 1;
    const prazo = new Date(agora.getTime() + 15 * 24 * 60 * 60 * 1000);
    const p: PedidoPortal = {
      id: `pd${seqPedido}`,
      protocolo: `${hoje.replace(/-/g, '')}-${seqPedido.toString(16).toUpperCase().padStart(8, '0')}`,
      tipo,
      abertoEm: agora.toISOString(),
      prazo: prazo.toISOString(),
      situacao: 'aberto',
      resposta: null,
    };
    pedidos.set(v.vinculoId, [...(pedidos.get(v.vinculoId) ?? []), p]);
    return p;
  }

  async function recibosDoPaciente() {
    const v = noVinculo();
    const lista = await banco.listarRecibos(v.pacienteId);
    return lista.map((r, i) => ({ r, numero: lista.length - i }));
  }

  return {
    vinculos: () => Promise.all(vinculos.map(paraVinculo)),
    async escolherVinculo(vinculoId) {
      const v = vinculos.find((x) => x.vinculoId === vinculoId);
      if (!v) throw new ErroPortal(404);
      escolhido = v;
      return paraVinculo(v);
    },
    sessao: async () => paraVinculo(noVinculo()),
    async resgatarConvite(token) {
      if (token.trim() !== TOKEN_CONVITE_DEMONSTRACAO) throw new ErroPortal(409, 'convite_invalido');
      return { canal: 'sms', destino: '(11) *****-0001' };
    },
    async confirmarConvite(token, codigo) {
      if (token.trim() !== TOKEN_CONVITE_DEMONSTRACAO || codigo.trim() !== CODIGO_CONVITE_DEMONSTRACAO) throw new ErroPortal(409, 'convite_invalido');
      if (vinculos.length === 0) vinculos.push({ vinculoId: 'v-titular', pacienteId: 'p01', agindoComo: 'titular' });
      escolhido = vinculos[0]!;
      return { vinculoId: escolhido.vinculoId };
    },
    async consultas() {
      const v = noVinculo();
      const desde = agora.getTime() - ANTECEDENCIA_CANCELAR_MS;
      const ags = (await banco.listarAgendamentos({ pacienteId: v.pacienteId, de: paraIsoLocal(new Date(desde)) })).filter((a) => inicio(a) >= desde);
      return ags.map((a): ConsultaPortal => {
        const falta = inicio(a) - agora.getTime();
        return {
          id: a.id,
          data: a.data,
          hora: a.hora,
          // Só o nome do profissional: sem especialidade nem tipo de atendimento (nada clínico).
          profissional: PROFISSIONAIS_FICTICIOS.find((p) => p.id === a.profissionalId)?.nome ?? '',
          status: a.status,
          podeConfirmar: a.status === 'agendado' && falta > 0,
          podeCancelar: (a.status === 'agendado' || a.status === 'confirmado') && falta >= ANTECEDENCIA_CANCELAR_MS,
        };
      });
    },
    async confirmarConsulta(id) {
      const a = await minhaConsulta(id);
      if (a.status !== 'agendado') throw new ErroPortal(409, 'status_nao_permite');
      if (inicio(a) <= agora.getTime()) throw new ErroPortal(409, 'consulta_ja_comecou');
      await banco.alterarStatus(id, 'confirmado');
      return { status: 'confirmado' };
    },
    async desfazerConfirmacao(id) {
      const a = await minhaConsulta(id);
      if (a.status !== 'confirmado') throw new ErroPortal(409, 'status_nao_permite');
      if (inicio(a) <= agora.getTime()) throw new ErroPortal(409, 'consulta_ja_comecou');
      await banco.alterarStatus(id, 'agendado');
      return { status: 'agendado' };
    },
    async cancelarConsulta(id) {
      const a = await minhaConsulta(id);
      if (a.status !== 'agendado' && a.status !== 'confirmado') throw new ErroPortal(409, 'status_nao_permite');
      const falta = inicio(a) - agora.getTime();
      if (falta <= 0) throw new ErroPortal(409, 'consulta_ja_comecou');
      if (falta < ANTECEDENCIA_CANCELAR_MS) throw new ErroPortal(409, 'prazo_de_cancelamento_encerrado');
      await banco.alterarStatus(id, 'cancelado');
      return { status: 'cancelado' };
    },
    async recibos() {
      return (await recibosDoPaciente()).map(({ r, numero }) => ({
        id: r.id,
        numero,
        data: r.data,
        valorCentavos: Math.round(r.valor * 100),
        forma: FORMA[r.forma],
        situacao: 'emitido' as const,
      }));
    },
    async recibo(id) {
      const achado = (await recibosDoPaciente()).find(({ r }) => r.id === id);
      if (!achado) throw new ErroPortal(404);
      const { r, numero } = achado;
      const p = await banco.obterPaciente(r.pacienteId);
      const pessoa = { nome: p?.nome ?? '', cpf: p?.cpf ?? null };
      return {
        id: r.id,
        numero,
        situacao: 'emitido',
        versao: 1,
        emitente: { tipo: 'pj', nome: 'Clínica Demonstração (fictícia)', documento: null, registroConselho: null },
        pagador: pessoa,
        beneficiario: pessoa,
        valorCentavos: Math.round(r.valor * 100),
        forma: FORMA[r.forma],
        dataPagamento: r.data,
        descricao: 'atendimento em saúde',
        pendencias: [],
      };
    },
    async documentos() {
      noVinculo();
      return { itens: [], disponivel: false };
    },
    async meusDados() {
      const v = noVinculo();
      const p = await banco.obterPaciente(v.pacienteId);
      if (!p) throw new ErroPortal(404);
      return {
        rotulo: v.agindoComo === 'responsavel_legal' ? 'dados_do_paciente' : 'meus_dados',
        nome: p.nome,
        nomeSocial: p.nomeSocial ?? null,
        telefone: p.telefone || null,
        cpfMascarado: p.cpf ? cpfMascarado(p.cpf) : null,
        nascimento: p.nascimento || null,
      };
    },
    async pedirCorrecao({ detalhe, nascimento }) {
      if (detalhe.trim().length < 3) throw new ErroPortal(400, undefined, ['detalhe']);
      if (nascimento !== undefined && (!ehDataAAAAMMDD(nascimento) || nascimento > hoje || nascimento < '1900-01-01')) {
        throw new ErroPortal(400, undefined, ['nascimento']);
      }
      return novoPedido('correcao');
    },
    async pedidos() {
      return [...(pedidos.get(noVinculo().vinculoId) ?? [])];
    },
    async abrirPedido(tipo) {
      return novoPedido(tipo);
    },
    async consentimentos() {
      const v = noVinculo();
      const evs = consentimentos.get(v.vinculoId) ?? {};
      return FINALIDADES.map((f): ConsentimentoPortal => {
        const lista = evs[f] ?? [];
        const base: ConsentimentoPortal = {
          finalidade: f,
          ...TEXTOS_CONSENTIMENTO[f],
          resposta: estado(lista),
          versaoTexto: VERSAO_TEXTO,
          atualizadoEm: lista.at(-1)?.em ?? null,
        };
        return f === 'escriba_ia' ? { ...base, estadoIa: estado(lista) === 'sim' ? 'informado_nao_recusou' : estado(lista) === 'nao' ? 'recusou' : 'nao_informado' } : base;
      });
    },
    async responderConsentimento(finalidade, resposta) {
      const v = noVinculo();
      const f = finalidadeValida(finalidade);
      const evs = consentimentos.get(v.vinculoId) ?? {};
      evs[f] = [...(evs[f] ?? []), { resposta, em: agora.toISOString(), canal: 'portal', agindoComo: v.agindoComo, versaoTexto: VERSAO_TEXTO }];
      consentimentos.set(v.vinculoId, evs);
      return { resposta: estado(evs[f]) };
    },
    async desfazerConsentimento(finalidade) {
      const v = noVinculo();
      const f = finalidadeValida(finalidade);
      const evs = consentimentos.get(v.vinculoId) ?? {};
      if (estado(evs[f]) === 'nao_respondido') throw new ErroPortal(409, 'nada_a_desfazer');
      evs[f] = [...(evs[f] ?? []), { resposta: 'desfeito', em: agora.toISOString(), canal: 'portal', agindoComo: v.agindoComo, versaoTexto: VERSAO_TEXTO }];
      consentimentos.set(v.vinculoId, evs);
      return { resposta: estado(evs[f]) };
    },
    async historicoConsentimento(finalidade) {
      const v = noVinculo();
      return [...(consentimentos.get(v.vinculoId)?.[finalidadeValida(finalidade)] ?? [])];
    },
  };
}
