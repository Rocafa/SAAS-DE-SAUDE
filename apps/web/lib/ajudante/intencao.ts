/**
 * Interpretador de pedidos em pt-BR do Ajudante.
 *
 * Fica atrás da interface `IntentParser` para, no futuro, plugar um LLM hospedado no Brasil (D3).
 * HOJE é só por regras, local e determinístico: nenhum texto digitado sai do navegador
 * (veto do Guardião: "achar Maria Silva" já é dado pessoal).
 */
import { tokens } from '../texto';
import { lerDataHora } from './datas';

export type Intencao =
  | { tipo: 'marcar_consulta'; paciente?: string; data?: string; hora?: string; encaixe: boolean }
  | { tipo: 'remarcar_consulta'; paciente?: string; data?: string; hora?: string }
  | { tipo: 'cancelar_consulta'; paciente?: string; data?: string }
  | { tipo: 'abrir_prontuario'; paciente?: string }
  | { tipo: 'abrir_ficha'; paciente?: string }
  | { tipo: 'imprimir_recibo'; paciente?: string }
  | { tipo: 'emitir_documento'; documento: 'atestado' | 'declaracao'; paciente?: string }
  | { tipo: 'registrar_chegada'; paciente?: string }
  | { tipo: 'ver_agenda'; data?: string }
  | { tipo: 'listar'; lista: 'falta_confirmar' | 'chegaram' | 'faltas' }
  | { tipo: 'cadastrar_paciente'; paciente?: string }
  | { tipo: 'ajuda'; pergunta: string };

export interface ContextoIntencao {
  agora: Date;
}

export interface IntentParser {
  interpretar(texto: string, contexto: ContextoIntencao): Intencao | null;
}

/** Palavras que nunca fazem parte do nome do paciente. */
const VAZIAS = new Set([
  'a', 'o', 'as', 'os', 'ao', 'aos', 'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'com', 'na', 'no', 'em',
  'um', 'uma', 'e', 'que', 'me', 'por', 'favor', 'pf', 'pfv', 'quero', 'queria', 'preciso', 'gostaria', 'pode', 'poderia',
  'consulta', 'consultas', 'sessao', 'sessoes', 'horario', 'agendamento', 'atendimento', 'paciente', 'senhor', 'senhora',
  'sr', 'sra', 'ultima', 'ultimo', 'proxima', 'proximo', 'manha', 'tarde', 'noite', 'dela', 'dele', 'hora', 'horas',
  'h', 'dia', 'vez', 'feira', 'nova', 'novo', 'outra', 'outro', 'mesmo', 'mesma', 'ja', 'agora', 'imprimir', 'imprime',
  'emitir', 'emite', 'gerar', 'gera', 'fazer', 'faz', 'faca', 'dar', 'tirar', 'segunda', 'via', 'reimprimir',
]);

interface Partes {
  paciente?: string;
  data?: string;
  hora?: string;
}

interface Regra {
  /** Palavras ou expressões (normalizadas) que disparam a regra. */
  gatilhos: string[];
  criar: (p: Partes) => Intencao;
}

/** Remove chaves com `undefined` (o tsconfig usa exactOptionalPropertyTypes). */
function sem<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

const REGRAS: Regra[] = [
  {
    gatilhos: ['remarcar', 'remarca', 'remarque', 'reagendar', 'reagenda', 'mudar', 'muda', 'trocar', 'troca', 'passar', 'passa', 'adiar', 'adia', 'transferir'],
    criar: (p) => sem({ tipo: 'remarcar_consulta' as const, ...p }),
  },
  {
    gatilhos: ['cancelar', 'cancela', 'cancele', 'desmarcar', 'desmarca', 'desmarque'],
    criar: ({ paciente, data }) => sem({ tipo: 'cancelar_consulta' as const, paciente, data }),
  },
  {
    gatilhos: ['encaixar', 'encaixa', 'encaixe', 'encaixo'],
    criar: (p) => sem({ tipo: 'marcar_consulta' as const, ...p, encaixe: true }),
  },
  {
    gatilhos: ['marcar', 'marca', 'marque', 'agendar', 'agende', 'agenda pra', 'agenda para', 'nova consulta', 'novo horario', 'novo agendamento'],
    criar: (p) => sem({ tipo: 'marcar_consulta' as const, ...p, encaixe: false }),
  },
  {
    gatilhos: ['recibo', 'recibos', 'comprovante'],
    criar: ({ paciente }) => sem({ tipo: 'imprimir_recibo' as const, paciente }),
  },
  {
    gatilhos: ['atestado'],
    criar: ({ paciente }) => sem({ tipo: 'emitir_documento' as const, documento: 'atestado' as const, paciente }),
  },
  {
    gatilhos: ['declaracao', 'comparecimento'],
    criar: ({ paciente }) => sem({ tipo: 'emitir_documento' as const, documento: 'declaracao' as const, paciente }),
  },
  {
    gatilhos: ['prontuario', 'evolucao', 'historico clinico', 'ficha clinica', 'iniciar atendimento', 'atender'],
    criar: ({ paciente }) => sem({ tipo: 'abrir_prontuario' as const, paciente }),
  },
  {
    gatilhos: ['cadastrar', 'cadastra', 'cadastre', 'novo paciente', 'nova paciente'],
    criar: ({ paciente }) => sem({ tipo: 'cadastrar_paciente' as const, paciente }),
  },
  {
    gatilhos: ['chegou', 'chegada', 'check in', 'checkin'],
    criar: ({ paciente }) => sem({ tipo: 'registrar_chegada' as const, paciente }),
  },
  {
    gatilhos: ['ficha', 'cadastro', 'telefone', 'abrir', 'abre', 'abra', 'ver', 'mostrar', 'mostra'],
    criar: ({ paciente }) => sem({ tipo: 'abrir_ficha' as const, paciente }),
  },
];

const PALAVRAS_GATILHO = new Set(REGRAS.flatMap((r) => r.gatilhos.flatMap((g) => g.split(' '))));

const PERGUNTA =
  /^(como|onde|o que|oque|qual|quais|porque|por que|pq|posso|da pra|da para|consigo|ajuda|socorro|nao sei|nao consigo|tem como|e possivel)\b/;

const LISTAS: { re: RegExp; lista: 'falta_confirmar' | 'chegaram' | 'faltas' }[] = [
  {
    re: /\b(falta confirmar|faltam confirmar|nao confirm\w*|a confirmar|sem confirmar|pendentes? de confirmacao|confirmar presenca)\b/,
    lista: 'falta_confirmar',
  },
  { re: /\b(quem (ja )?chegou|quem esta aqui|quem ta aqui|ja chegaram|chegaram|sala de espera|esperando)\b/, lista: 'chegaram' },
  { re: /\b(quem faltou|faltaram|faltas de|faltosos|as faltas)\b/, lista: 'faltas' },
];

function acharGatilho(palavras: string[], gatilho: string): number[] | null {
  const g = gatilho.split(' ');
  for (let i = 0; i + g.length <= palavras.length; i++) {
    if (g.every((x, k) => palavras[i + k] === x)) return g.map((_, k) => i + k);
  }
  return null;
}

export class InterpretadorPorRegras implements IntentParser {
  interpretar(texto: string, { agora }: ContextoIntencao): Intencao | null {
    const palavras = tokens(texto);
    if (!palavras.length) return null;
    const frase = palavras.join(' ');

    if (PERGUNTA.test(frase) || texto.trim().endsWith('?')) {
      const lista = LISTAS.find((l) => l.re.test(frase));
      if (lista && !/^(como|onde)\b/.test(frase)) return { tipo: 'listar', lista: lista.lista };
      return { tipo: 'ajuda', pergunta: frase };
    }
    for (const l of LISTAS) if (l.re.test(frase)) return { tipo: 'listar', lista: l.lista };

    const { data, hora, usadas } = lerDataHora(palavras, agora);

    // "agenda", "agenda de amanhã", "abrir agenda de sexta" (não confundir com "agenda pra Maria").
    if (palavras.includes('agenda')) {
      const resto = palavras.filter(
        (p, i) => !usadas.has(i) && !VAZIAS.has(p) && !/^(agenda|ver|abrir|abre|abra|mostrar|mostra|minha|semana|hoje)$/.test(p),
      );
      if (resto.length === 0) return sem({ tipo: 'ver_agenda' as const, data });
    }

    for (const regra of REGRAS) {
      for (const gatilho of regra.gatilhos) {
        const pos = acharGatilho(palavras, gatilho);
        if (!pos) continue;
        const fora = new Set([...usadas, ...pos]);
        const nome = palavras
          .filter((p, i) => !fora.has(i) && !VAZIAS.has(p) && !PALAVRAS_GATILHO.has(p) && !/^\d+$/.test(p))
          .join(' ');
        return regra.criar(sem({ paciente: nome || undefined, data, hora }));
      }
    }
    return null;
  }
}

export const interpretadorPadrao: IntentParser = new InterpretadorPorRegras();
