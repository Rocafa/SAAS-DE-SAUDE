import { BadRequestException } from '@nestjs/common';

/**
 * Validação de entrada ESTRITA e sem dependência externa. Regras:
 * - corpo/consulta precisam ser objetos simples; chave desconhecida é erro (inclusive `tenantId`:
 *   a clínica vem SEMPRE da sessão, regra 1 da D4);
 * - texto sem caracteres de controle e com limite de tamanho;
 * - a resposta de erro diz QUAIS campos falharam, nunca o valor recebido (pode ser dado pessoal).
 */
export class EntradaInvalidaError extends BadRequestException {
  constructor(readonly campos: readonly string[]) {
    super({ statusCode: 400, message: 'Dados inválidos', campos: [...new Set(campos)].sort() });
    this.name = 'EntradaInvalidaError';
  }
}

export type Entrada = Readonly<Record<string, unknown>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Controles C0/C1 (inclui quebra de linha) e separadores de linha/parágrafo Unicode.
function temControle(texto: string): boolean {
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** Exige objeto simples só com as chaves permitidas. */
export function exigirObjeto(valor: unknown, permitidas: readonly string[]): Entrada {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) throw new EntradaInvalidaError(['corpo']);
  const proto: unknown = Object.getPrototypeOf(valor);
  if (proto !== Object.prototype && proto !== null) throw new EntradaInvalidaError(['corpo']);
  const extras = Object.keys(valor).filter((k) => !permitidas.includes(k));
  if (extras.length > 0) {
    // Nome de chave desconhecida também não volta na resposta (poderia ser texto arbitrário).
    throw new EntradaInvalidaError(['campo_desconhecido']);
  }
  return valor as Entrada;
}

export function ehUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && UUID_RE.test(valor);
}

/** Parâmetro de rota `:id`. */
export function exigirUuid(valor: unknown, campo = 'id'): string {
  if (!ehUuid(valor)) throw new EntradaInvalidaError([campo]);
  return valor.toLowerCase();
}

/** Coletor: junta todos os campos inválidos e falha uma vez só. */
export class Validador {
  private readonly erros: string[] = [];

  constructor(private readonly entrada: Entrada) {}

  tem(campo: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entrada, campo) && this.entrada[campo] !== undefined;
  }

  falhar(campo: string): void {
    this.erros.push(campo);
  }

  texto(campo: string, opcoes: { min?: number; max: number; obrigatorio: true }): string;
  texto(campo: string, opcoes: { min?: number; max: number; obrigatorio?: false }): string | undefined;
  texto(campo: string, opcoes: { min?: number; max: number; obrigatorio?: boolean }): string | undefined {
    if (!this.tem(campo)) {
      if (opcoes.obrigatorio) this.falhar(campo);
      return undefined;
    }
    const v = this.entrada[campo];
    if (typeof v !== 'string') {
      this.falhar(campo);
      return undefined;
    }
    const t = v.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    if (t.length < (opcoes.min ?? 1) || t.length > opcoes.max || temControle(t)) {
      this.falhar(campo);
      return undefined;
    }
    return t;
  }

  /** Texto opcional que aceita `null` explícito (para limpar o campo num PATCH). */
  textoOuNulo(campo: string, opcoes: { min?: number; max: number }): string | null | undefined {
    if (this.tem(campo) && this.entrada[campo] === null) return null;
    return this.texto(campo, opcoes);
  }

  uuid(campo: string, obrigatorio: boolean): string | undefined {
    if (!this.tem(campo)) {
      if (obrigatorio) this.falhar(campo);
      return undefined;
    }
    const v = this.entrada[campo];
    if (!ehUuid(v)) {
      this.falhar(campo);
      return undefined;
    }
    return v.toLowerCase();
  }

  booleano(campo: string): boolean | undefined {
    if (!this.tem(campo)) return undefined;
    const v = this.entrada[campo];
    if (typeof v !== 'boolean') {
      this.falhar(campo);
      return undefined;
    }
    return v;
  }

  inteiro(campo: string, opcoes: { min: number; max: number; obrigatorio?: boolean }): number | undefined {
    if (!this.tem(campo)) {
      if (opcoes.obrigatorio) this.falhar(campo);
      return undefined;
    }
    const v = this.entrada[campo];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < opcoes.min || v > opcoes.max) {
      this.falhar(campo);
      return undefined;
    }
    return v;
  }

  /** Inteiro vindo da query string (sempre texto). */
  inteiroDeTexto(campo: string, opcoes: { min: number; max: number; padrao: number }): number {
    if (!this.tem(campo)) return opcoes.padrao;
    const v = this.entrada[campo];
    if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) {
      this.falhar(campo);
      return opcoes.padrao;
    }
    const n = Number(v);
    if (n < opcoes.min || n > opcoes.max) {
      this.falhar(campo);
      return opcoes.padrao;
    }
    return n;
  }

  umDe<T extends string>(campo: string, valores: readonly T[], obrigatorio: boolean): T | undefined {
    if (!this.tem(campo)) {
      if (obrigatorio) this.falhar(campo);
      return undefined;
    }
    const v = this.entrada[campo];
    if (typeof v !== 'string' || !(valores as readonly string[]).includes(v)) {
      this.falhar(campo);
      return undefined;
    }
    return v as T;
  }

  /** Falha se houve qualquer erro; depois disso os campos obrigatórios estão garantidos. */
  concluir(): void {
    if (this.erros.length > 0) throw new EntradaInvalidaError(this.erros);
  }
}

/** Data de calendário AAAA-MM-DD válida (sem fuso). */
export function ehDataValida(valor: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const d = new Date(`${valor}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

/** Hora HH:MM (00:00 a 23:59). */
export function ehHoraValida(valor: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(valor);
}
