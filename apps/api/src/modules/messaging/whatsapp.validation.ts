import { ehDataValida, EntradaInvalidaError, exigirObjeto, Validador } from '../../common/validacao';
import { textoEhNeutro } from './lembretes-regras';

/**
 * Validação ESTRITA das rotas do WhatsApp (chave desconhecida é erro; a resposta diz o campo, nunca o
 * valor). Número de telefone, texto e nome nunca vão na URL (V1 do parecer PR #57).
 */

export interface ConfiguracaoWhatsapp {
  readonly ativo?: boolean;
  readonly nomeRemetente?: string | null;
  readonly numeroDeNegocio?: string | null;
  readonly horasAntes?: number;
  readonly enviarDe?: number;
  readonly enviarAte?: number;
  readonly janelaRespostaHoras?: number;
}

export function validarConfiguracao(corpo: unknown): ConfiguracaoWhatsapp {
  const v = new Validador(
    exigirObjeto(corpo, ['ativo', 'nomeRemetente', 'numeroDeNegocio', 'horasAntes', 'enviarDe', 'enviarAte', 'janelaRespostaHoras']),
  );
  const ativo = v.booleano('ativo');
  const nomeRemetente = v.textoOuNulo('nomeRemetente', { min: 2, max: 40 });
  // Nome NEUTRO: sem especialidade, profissional ou condição (vai na tela de bloqueio do paciente).
  if (typeof nomeRemetente === 'string' && !textoEhNeutro(nomeRemetente)) v.falhar('nomeRemetente');
  const numeroDeNegocio = v.textoOuNulo('numeroDeNegocio', { max: 32 });
  if (typeof numeroDeNegocio === 'string' && !/^[0-9]{5,32}$/.test(numeroDeNegocio)) v.falhar('numeroDeNegocio');
  const horasAntes = v.inteiro('horasAntes', { min: 2, max: 72 });
  const enviarDe = v.inteiro('enviarDe', { min: 0, max: 23 });
  const enviarAte = v.inteiro('enviarAte', { min: 1, max: 24 });
  const janelaRespostaHoras = v.inteiro('janelaRespostaHoras', { min: 1, max: 72 });
  v.concluir();
  return {
    ...(ativo !== undefined ? { ativo } : {}),
    ...(nomeRemetente !== undefined ? { nomeRemetente } : {}),
    ...(numeroDeNegocio !== undefined ? { numeroDeNegocio } : {}),
    ...(horasAntes !== undefined ? { horasAntes } : {}),
    ...(enviarDe !== undefined ? { enviarDe } : {}),
    ...(enviarAte !== undefined ? { enviarAte } : {}),
    ...(janelaRespostaHoras !== undefined ? { janelaRespostaHoras } : {}),
  };
}

export interface NovoOptIn {
  readonly destinatario: 'paciente' | 'responsavel';
  readonly responsavelId?: string;
  /** Pela rota da recepção (R7 do #69): `portal_do_paciente` só pela sessão do portal (#68). */
  readonly meio: 'verbal_na_recepcao' | 'formulario_assinado';
  /** Obrigatório (R7 do #69): nº do termo assinado, protocolo do registro verbal etc. */
  readonly comprovante: string;
}

export function validarNovoOptIn(corpo: unknown): NovoOptIn {
  const v = new Validador(exigirObjeto(corpo, ['destinatario', 'responsavelId', 'meio', 'comprovante']));
  const destinatario = v.umDe('destinatario', ['paciente', 'responsavel'] as const, true);
  const responsavelId = v.uuid('responsavelId', destinatario === 'responsavel');
  if (destinatario === 'paciente' && responsavelId !== undefined) v.falhar('responsavelId');
  const meio = v.umDe('meio', ['verbal_na_recepcao', 'formulario_assinado'] as const, true);
  // Referência do comprovante (nº do termo, protocolo): OBRIGATÓRIA (R7); fica cifrada; nunca na trilha.
  const comprovante = v.texto('comprovante', { min: 3, max: 120, obrigatorio: true });
  v.concluir();
  return {
    destinatario: destinatario ?? 'paciente',
    ...(responsavelId ? { responsavelId } : {}),
    meio: meio ?? 'verbal_na_recepcao',
    comprovante: comprovante ?? '',
  };
}

export function validarRevogacao(corpo: unknown): 'pedido_na_recepcao' {
  const v = new Validador(exigirObjeto(corpo ?? {}, ['meio']));
  // Pela recepção (R7 do #69): a revogação pelo portal vem só da sessão do portal (#68).
  const meio = v.umDe('meio', ['pedido_na_recepcao'] as const, true);
  v.concluir();
  return meio ?? 'pedido_na_recepcao';
}

export interface FiltroEnvios {
  readonly de: string;
  readonly ate: string;
  readonly situacao: 'todos' | 'falhou';
}

const JANELA_ENVIOS_DIAS = 31;

export function validarFiltroEnvios(query: unknown): FiltroEnvios {
  if (typeof query === 'object' && query !== null && ['telefone', 'numero', 'texto', 'nome', 'busca'].some((k) => Object.prototype.hasOwnProperty.call(query, k))) {
    throw new EntradaInvalidaError(['dado_na_url']);
  }
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'situacao']));
  const de = v.texto('de', { max: 10, obrigatorio: true });
  const ate = v.texto('ate', { max: 10, obrigatorio: true });
  const situacao = v.umDe('situacao', ['todos', 'falhou'] as const, false);
  if (de !== undefined && !ehDataValida(de)) v.falhar('de');
  if (ate !== undefined && !ehDataValida(ate)) v.falhar('ate');
  if (de && ate && ehDataValida(de) && ehDataValida(ate)) {
    const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
    if (dias < 0 || dias >= JANELA_ENVIOS_DIAS) v.falhar('ate');
  }
  v.concluir();
  return { de: de ?? '', ate: ate ?? '', situacao: situacao ?? 'todos' };
}
