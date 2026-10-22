import { normalizarTextoParaChecagem } from '../finance/financeiro-regras';
import { noFusoDaClinica } from '../scheduling/agenda-regras';

/**
 * Regras puras dos lembretes por WhatsApp (rodada 18.3). Sem banco, sem rede.
 *
 * Neutralidade (RIPD-whatsapp §4 e R8; requisitos-tecnicos-seguranca §12): a mensagem leva SÓ o nome
 * neutro da clínica, a data e a hora. Não existe placeholder de profissional, especialidade, tipo de
 * atendimento ou procedimento, e o texto do modelo e o nome do remetente passam por esta lista — que é
 * mais dura que a do recibo: aqui NENHUMA especialidade entra (o canal é de terceiro e aparece na tela de
 * bloqueio). A mesma lista existe no banco (`app_whatsapp_text_is_neutral`, 0032) e o teste confere que
 * cada termo daqui também é recusado lá.
 */

/** Amostras de termos proibidos (o teste roda cada uma contra o banco e contra a função daqui). */
export const AMOSTRAS_DE_TERMOS_SENSIVEIS: readonly string[] = [
  'Psiquiatria',
  'psicóloga',
  'psicoterapia',
  'psicanálise',
  'Oncologia',
  'câncer',
  'quimioterapia',
  'HIV',
  'infectologia',
  'ginecologia',
  'obstetrícia',
  'pré-natal',
  'urologia',
  'dependência química',
  'álcool',
  'saúde mental',
  'neurologia',
  'cardiologia',
  'dermatologia',
  'nutricionista',
  'fonoaudiologia',
  'fisioterapia',
  'odontologia',
  'pediatria',
  'ortopedia',
  'transtorno',
  'depressão',
  'ansiedade',
  'autismo',
  'TDAH',
  'Dra. Fulana',
  'doutor',
  'especialidade',
  'diagnóstico',
  'exame',
];

const TERMOS: readonly RegExp[] = [
  /psiq|psicol|psicot|psicanal|psicopedag|terapi|terapeut/,
  /oncol|cancer|quimiot|radiot|\bhiv\b|\baids\b|infectol|hepatit|sifilis|\bist\b|\bdst\b/,
  /ginecol|obstetr|pre-?natal|aborto|fertilid|reproducao|urolog|proctolog/,
  /dependencia|alcool|droga|reabilit|saude mental/,
  /neurol|cardiol|dermatol|endocrin|nutri|fonoaud|fisiot|odont|dentist|pediatr|geriatr|ortoped|oftalm|otorrino|mastol|hematol|nefrol|dialise/,
  /transtorno|depress|ansiedade|autismo|\btea\b|tdah|bipolar|esquizof/,
  /\bdra?\b|doutor|especialid|sexolog|estetic|\bcid\b|diagnost|exame/,
];

function semAcento(t: string): string {
  return t.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Texto sem termo de especialidade, profissional, condição ou exame (normalizado como no recibo, R16). */
export function textoEhNeutro(texto: string): boolean {
  const t = semAcento(normalizarTextoParaChecagem(texto)).toLowerCase();
  return !TERMOS.some((re) => re.test(t));
}

/**
 * Modelos da PLATAFORMA (V3 do parecer #69): lista FECHADA e versionada no código. Cada item junta o
 * nome do modelo aprovado na Meta e o texto aprovado pelo Guardião; os dois são conferidos JUNTOS:
 * - no banco, `whatsapp_outbox.template_name` só aceita os nomes de `app_whatsapp_platform_templates()`
 *   (0032; o teste confere que a lista do banco é igual a esta);
 * - na subida com `cloud_api`, o texto do modelo cadastrado na Meta tem de ser IGUAL a `corpoNaMeta`
 *   (`conferirModelos`); se não for, a API não sobe.
 * A clínica NÃO cria modelo. Modelo novo = nova versão aqui + aprovação do Guardião + migração nova.
 */
export interface ModeloDaPlataforma {
  readonly nomeNoProvedor: string;
  readonly idioma: 'pt_BR';
  /** Texto com {clinica}, {data} e {hora} (nesta ordem viram {{1}}, {{2}}, {{3}} na Meta). */
  readonly corpo: string;
  /** Onde o Guardião aprovou o texto. */
  readonly aprovacao: string;
}

export const MODELOS_DA_PLATAFORMA: readonly ModeloDaPlataforma[] = [
  {
    nomeNoProvedor: 'lembrete_neutro_v1',
    idioma: 'pt_BR',
    corpo: 'Você tem um compromisso em {clinica} dia {data} às {hora}. Responda 1 para confirmar, 2 para cancelar ou SAIR para não receber mais. Este número não lê outras mensagens.',
    aprovacao: 'docs/03-seguranca-lgpd/revisoes/2026-10-21-pr69.md (modelo padrão pedido pelo Guardião)',
  },
];

/** Modelo em uso nos lembretes (o mais recente da lista). */
export const MODELO_PADRAO: ModeloDaPlataforma = MODELOS_DA_PLATAFORMA[MODELOS_DA_PLATAFORMA.length - 1] as ModeloDaPlataforma;

/** Modelo da plataforma pelo nome; fora da lista: null (o envio não sai). */
export function modeloDaPlataforma(nome: string): ModeloDaPlataforma | null {
  return MODELOS_DA_PLATAFORMA.find((m) => m.nomeNoProvedor === nome) ?? null;
}

const PLACEHOLDER_RE = /\{([^}]*)\}/g;
const PLACEHOLDERS = ['clinica', 'data', 'hora'] as const;

/** Texto como fica cadastrado na Meta: os placeholders viram {{1}}, {{2}}... na ordem em que aparecem. */
export function corpoNaMeta(corpo: string): string {
  let n = 0;
  return corpo.replace(PLACEHOLDER_RE, () => `{{${++n}}}`);
}

/** Corpo de modelo aceitável: 20..400 caracteres, só {clinica}/{data}/{hora}, com data e hora, neutro. */
export function corpoDeModeloValido(corpo: string): boolean {
  if (corpo.length < 20 || corpo.length > 400) return false;
  const usados = [...corpo.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  if (usados.some((p) => !(PLACEHOLDERS as readonly string[]).includes(p ?? ''))) return false;
  if (!usados.includes('data') || !usados.includes('hora')) return false;
  if (/\{\{|\}\}/.test(corpo)) return false;
  return textoEhNeutro(corpo);
}

/** Texto final: os únicos dados são o nome neutro, a data (dd/mm) e a hora (HH:MM) no fuso da clínica. */
export function renderizarLembrete(corpo: string, clinica: string, inicio: Date): { texto: string; parametros: string[] } {
  const { data, hora } = noFusoDaClinica(inicio);
  const dataCurta = `${data.slice(8, 10)}/${data.slice(5, 7)}`;
  const valores: Record<(typeof PLACEHOLDERS)[number], string> = { clinica, data: dataCurta, hora };
  const parametros: string[] = [];
  const texto = corpo.replace(PLACEHOLDER_RE, (_, nome: string) => {
    const v = valores[nome as (typeof PLACEHOLDERS)[number]];
    parametros.push(v);
    return v;
  });
  // Defesa em profundidade: o que sai tem de continuar neutro (o nome do remetente também foi checado).
  if (!textoEhNeutro(texto)) throw new Error('lembrete com termo sensível: envio bloqueado');
  return { texto, parametros };
}

export type Interpretacao = 'confirmar' | 'cancelar' | 'sair' | 'outro';

/** "1"/"2" (com ou sem pontuação, ou o id do botão), SAIR/PARAR; o resto é "outro" (nenhuma ação). */
export function interpretarResposta(texto: string): Interpretacao {
  const t = semAcento(normalizarTextoParaChecagem(texto)).toLowerCase().replace(/[.!\s]+$/u, '').trim();
  if (t === '1' || t === 'confirmar' || t === 'confirmo') return 'confirmar';
  if (t === '2' || t === 'cancelar' || t === 'cancelo') return 'cancelar';
  if (t === 'sair' || t === 'parar' || t === 'pare' || t === 'stop') return 'sair';
  return 'outro';
}

/**
 * Resposta FIXA a qualquer mensagem que não seja 1/2/SAIR (R1 do parecer #69). O que o paciente escreveu
 * não é guardado nem lido (não há inbox): a orientação é ligar para a clínica. Neutra como o lembrete.
 */
export const RESPOSTA_FIXA_OUTRO =
  'Este número só envia lembretes e não lê mensagens. Responda 1 para confirmar, 2 para cancelar ou SAIR para não receber mais. Para qualquer outro assunto, ligue para a clínica.';

/** Antecedência mínima: lembrete que chegaria a menos de 2 h da consulta não sai (vira ruído). */
export const ANTECEDENCIA_MINIMA_H = 2;
const HORA_MS = 3_600_000;

/** A consulta está na janela do lembrete: (agora + 2 h, agora + antecedência configurada]. */
export function lembreteDevido(inicio: Date, agora: Date, horasAntes: number): boolean {
  const t = inicio.getTime() - agora.getTime();
  return t > ANTECEDENCIA_MINIMA_H * HORA_MS && t <= horasAntes * HORA_MS;
}

/** Hora local da clínica dentro de [de, ate). Fora dela nada é enviado (nem lembrete, nem nova tentativa). */
export function dentroDoHorarioDeEnvio(agora: Date, de: number, ate: number): boolean {
  const h = Number(noFusoDaClinica(agora).hora.slice(0, 2));
  return h >= de && h < ate;
}

/** A resposta vale para o envio: até `janelaHoras` depois do envio e antes do início da consulta. */
export function respostaNaJanela(enviadoEm: Date | null, inicio: Date, agora: Date, janelaHoras: number): boolean {
  if (!enviadoEm) return false;
  return agora.getTime() <= enviadoEm.getTime() + janelaHoras * HORA_MS && agora.getTime() < inicio.getTime();
}

/** Telefone do cadastro (DDD + número) no formato do WhatsApp (DDI 55); inválido: null. */
export function telefoneParaWhatsapp(telefone: string | null): string | null {
  if (!telefone) return null;
  const d = telefone.replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(d)) return d;
  if (/^\d{10,11}$/.test(d)) return `55${d}`;
  return null;
}

/** Mesmo número? Compara no formato do WhatsApp (o provedor manda com DDI). */
export function mesmoTelefone(a: string | null, b: string | null): boolean {
  const x = telefoneParaWhatsapp(a);
  return x !== null && x === telefoneParaWhatsapp(b);
}

/** Código de falha gravável (CHECK da 0032): minúsculas, dígitos e _. */
export function codigoDeFalha(codigo: string): string {
  const c = codigo.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  return c.length > 0 ? c : 'desconhecido';
}

/**
 * Retenção (R2/R3 do parecer #69; matriz-retencao.md §3). O banco aplica os números (0032:
 * app_whatsapp_content_retention_days e app_whatsapp_stuck_sending_hours); aqui só para a trilha e a doc.
 * - CONTEÚDO do envio (texto renderizado e número, cifrados): 30 dias;
 * - "enviando" preso: 24 h, depois "falhou" com fallback; "agendado" de consulta passada: cancelado;
 * - METADADO (status, datas, códigos, HMAC do número; respostas só com interpretação/resultado):
 *   acompanha o cadastro do paciente (sai com a eliminação dele);
 * - OPT-IN e prova: enquanto vigente + prazo prescricional após a revogação (PROPOSTA 5 anos ⚖️).
 */
export const RETENCAO_DO_CONTEUDO_DIAS = 30;
export const ENVIANDO_PRESO_HORAS = 24;
export const RETENCAO_DA_PROVA_DO_OPT_IN_ANOS_PROPOSTA = 5;

/** Até 5 respostas são processadas por envio; o excesso é descartado sem gravar (limite do webhook). */
export const MAX_RESPOSTAS_POR_ENVIO = 5;
/** Tentativas de envio antes de virar "falhou" (e ir para a fila da recepção). */
export const MAX_TENTATIVAS = 3;
