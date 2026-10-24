/**
 * Montagem das RESPOSTAS do portal no formato do contrato `ApiPortal` (packages/shared, fonte única).
 * Funções puras: o serviço lê o banco e chama estas funções; o teste de contrato (portal-contrato.test.ts)
 * chama as MESMAS funções e confere o resultado contra o contrato em tempo de execução.
 *
 * As asserções de tipo no fim do arquivo amarram os enums do banco aos do contrato: se um lado mudar
 * sem o outro, o typecheck falha.
 */
import type {
  ConsentimentoPortal,
  ConsultaPortal,
  DesafioDoConvitePortal,
  PedidoPortal,
  PortalAgindoComo,
  PortalEstadoIa,
  PortalEventoConsentimento,
  PortalFinalidade,
  PortalFormaDePagamento,
  PortalRespostaConsentimento,
  PortalStatusConsulta,
  PortalTipoDePedido,
  ReciboPortal,
  ReciboPortalResumo,
  VinculoDaConta,
} from '@plataforma/shared';
import type {
  AiConsentState,
  AppointmentStatusDb,
  PaymentMethod,
  PortalActingAs,
  PortalConsentPurpose,
  PortalConsentResponse,
  RightsRequestKind,
  RightsRequestStatus,
} from '../../db/schema';
import type { ConteudoDoRecibo } from '../finance/financeiro-regras';
import { noFusoDaClinica, statusParaFront, type StatusFront } from '../scheduling/agenda-regras';
import { mascararTelefone } from './portal-otp';
import {
  CONSENTIMENTOS,
  consentimentoIa,
  estadoDoConsentimento,
  mascararCpf,
  situacaoParaOTitular,
  VERSAO_TEXTOS_CONSENTIMENTO,
  type RespostaConsentimento,
} from './portal-regras';

export function vinculoParaPortal(vinculoId: string, clinica: string, primeiroNome: string, agindoComo: PortalActingAs): VinculoDaConta {
  return { vinculoId, clinica, primeiroNome, agindoComo };
}

/** Passo 1 do resgate: só o canal e o destino MASCARADO (o telefone do cadastro nunca sai inteiro). */
export function desafioDoConvite(telefoneDigitos: string): DesafioDoConvitePortal {
  return { canal: 'sms', destino: mascararTelefone(telefoneDigitos) };
}

/** Consulta do portal: os botões vêm prontos (`podeConfirmar`/`podeCancelar`); nada da especialidade. */
export function consultaParaPortal(
  a: { readonly id: string; readonly startsAt: Date; readonly status: AppointmentStatusDb },
  profissional: string,
  agoraMs: number,
  antecedenciaH: number,
): ConsultaPortal {
  const { data, hora } = noFusoDaClinica(a.startsAt);
  const futura = a.startsAt.getTime() > agoraMs;
  return {
    id: a.id,
    data,
    hora,
    profissional,
    status: statusParaFront(a.status),
    podeConfirmar: futura && a.status === 'scheduled',
    podeCancelar: (a.status === 'scheduled' || a.status === 'confirmed') && a.startsAt.getTime() - agoraMs >= antecedenciaH * 3_600_000,
  };
}

export function reciboResumoParaPortal(
  r: { readonly id: string; readonly number: number },
  p: { readonly receivedAt: Date; readonly amountCents: number; readonly method: PaymentMethod },
  cancelado: boolean,
): ReciboPortalResumo {
  return {
    id: r.id,
    numero: r.number,
    data: noFusoDaClinica(p.receivedAt).data,
    valorCentavos: p.amountCents,
    forma: p.method,
    situacao: cancelado ? 'cancelado' : 'emitido',
  };
}

/**
 * Recibo do portal (retrato emitido). O CPF do PAGADOR terceiro (ex.: responsável) sai mascarado; o
 * titular vê o próprio CPF (beneficiário) inteiro. Campos montados um a um: nada do retrato que não
 * esteja no contrato passa adiante.
 */
export function reciboParaPortal(c: ConteudoDoRecibo, id: string, numero: number, cancelado: boolean): ReciboPortal {
  const terceiro = c.pagador.cpf !== null && c.pagador.cpf !== c.beneficiario.cpf;
  return {
    id,
    numero,
    situacao: cancelado ? 'cancelado' : 'emitido',
    versao: c.versao,
    emitente: {
      tipo: c.emitente.tipo,
      nome: c.emitente.nome,
      documento: c.emitente.documento,
      registroConselho: c.emitente.registroConselho,
      profissionalId: c.emitente.profissionalId,
    },
    pagador: { nome: c.pagador.nome, cpf: terceiro ? mascararCpf(c.pagador.cpf) : c.pagador.cpf },
    beneficiario: { nome: c.beneficiario.nome, cpf: c.beneficiario.cpf },
    valorCentavos: c.valorCentavos,
    forma: c.forma,
    dataPagamento: c.dataPagamento,
    descricao: c.descricao,
    pendencias: [...c.pendencias],
  };
}

/** Consentimento com o texto DO SERVIDOR (título, explicação e versão: o que o hash do evento prova). */
export function consentimentoParaPortal(f: PortalConsentPurpose, ultimo: { readonly response: PortalConsentResponse; readonly createdAt: Date } | undefined): ConsentimentoPortal {
  const resposta = estadoDoConsentimento(ultimo?.response);
  return {
    finalidade: f,
    titulo: CONSENTIMENTOS[f].titulo,
    explicacao: CONSENTIMENTOS[f].explicacao,
    resposta,
    versaoTexto: VERSAO_TEXTOS_CONSENTIMENTO,
    atualizadoEm: ultimo?.createdAt.toISOString() ?? null,
    ...(f === 'escriba_ia' ? { estadoIa: consentimentoIa(resposta) } : {}),
  };
}

export function pedidoParaPortal(
  r: { readonly id: string; readonly protocol: string; readonly kind: RightsRequestKind; readonly createdAt: Date; readonly dueAt: Date; readonly status: RightsRequestStatus },
  resposta: string | null,
): PedidoPortal {
  return {
    id: r.id,
    protocolo: r.protocol,
    tipo: r.kind,
    abertoEm: r.createdAt.toISOString(),
    prazo: r.dueAt.toISOString(),
    situacao: situacaoParaOTitular(r.status),
    resposta,
  };
}

// ------------------------------------------------------------------ banco × contrato (typecheck)

type Igual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function mesmoTipo<T extends true>(): T | undefined {
  return undefined;
}
mesmoTipo<Igual<PortalActingAs, PortalAgindoComo>>();
mesmoTipo<Igual<StatusFront, PortalStatusConsulta>>();
mesmoTipo<Igual<PaymentMethod, PortalFormaDePagamento>>();
mesmoTipo<Igual<RightsRequestKind, PortalTipoDePedido>>();
mesmoTipo<Igual<PortalConsentPurpose, PortalFinalidade>>();
mesmoTipo<Igual<PortalConsentResponse, PortalEventoConsentimento>>();
mesmoTipo<Igual<RespostaConsentimento, PortalRespostaConsentimento>>();
mesmoTipo<Igual<AiConsentState, PortalEstadoIa>>();
mesmoTipo<Igual<ReturnType<typeof situacaoParaOTitular>, PedidoPortal['situacao']>>();
/** O retrato emitido inteiro cabe no recibo do contrato (campo novo no retrato = decidir se vai ao portal). */
mesmoTipo<Igual<keyof ConteudoDoRecibo | 'id' | 'numero' | 'situacao', keyof ReciboPortal>>();
mesmoTipo<Igual<ConteudoDoRecibo['emitente']['tipo'], ReciboPortal['emitente']['tipo']>>();
