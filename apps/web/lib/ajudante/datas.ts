/**
 * Datas e horas relativas em pt-BR, por regras locais e determinísticas:
 * "hoje", "amanhã", "depois de amanhã", "quinta", "sexta que vem", "dia 15", "15/10",
 * "daqui a 3 dias", "14h", "14:30", "às duas da tarde", "10 e meia", "meio-dia".
 * Recebe as palavras já normalizadas (sem acento, minúsculas).
 */

export interface DataHoraLida {
  /** AAAA-MM-DD, no fuso local. */
  data?: string;
  /** HH:MM. */
  hora?: string;
  /** Índices das palavras que foram usadas como data ou hora. */
  usadas: Set<number>;
}

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  seg: 1,
  terca: 2,
  ter: 2,
  quarta: 3,
  qua: 3,
  quinta: 4,
  qui: 4,
  sexta: 5,
  sex: 5,
  sabado: 6,
  sab: 6,
};

const MESES: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const NUMEROS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
};

export function paraIsoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function deIsoLocal(iso: string): Date {
  const [a, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(a, m - 1, d);
}

export function somarDias(base: Date, dias: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + dias);
  return d;
}

function hhmm(h: number, m: number): string | undefined {
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function numero(palavra: string | undefined): number | undefined {
  if (palavra === undefined) return undefined;
  if (/^\d{1,2}$/.test(palavra)) return Number(palavra);
  return NUMEROS[palavra];
}

const PALAVRA_HORA = /^(h|hora|horas)$/;

export function lerDataHora(palavras: string[], agora: Date): DataHoraLida {
  const usadas = new Set<number>();
  let data: Date | undefined;
  let hora: string | undefined;
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  for (let i = 0; i < palavras.length; i++) {
    if (usadas.has(i)) continue;
    const p = palavras[i]!;
    const prox = palavras[i + 1];

    if (p === 'depois' && prox === 'de' && palavras[i + 2] === 'amanha') {
      data = somarDias(hoje, 2);
      usadas.add(i).add(i + 1).add(i + 2);
      continue;
    }
    if (p === 'hoje') {
      data = hoje;
      usadas.add(i);
      continue;
    }
    if (p === 'amanha') {
      data = somarDias(hoje, 1);
      usadas.add(i);
      continue;
    }
    // daqui a 3 dias / em 3 dias
    if ((p === 'daqui' && prox === 'a') || p === 'em') {
      const desloc = p === 'em' ? 1 : 2;
      const n = numero(palavras[i + desloc]);
      if (n !== undefined && /^dias?$/.test(palavras[i + desloc + 1] ?? '')) {
        data = somarDias(hoje, n);
        for (let k = 0; k <= desloc + 1; k++) usadas.add(i + k);
        continue;
      }
    }
    if (p === 'semana' && prox === 'que' && palavras[i + 2] === 'vem') {
      if (!data) data = somarDias(hoje, 7);
      usadas.add(i).add(i + 1).add(i + 2);
      if (i > 0 && palavras[i - 1] === 'na') usadas.add(i - 1);
      continue;
    }
    if (p in DIAS_SEMANA) {
      const alvo = DIAS_SEMANA[p]!;
      let delta = (alvo - hoje.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      data = somarDias(hoje, delta);
      usadas.add(i);
      let j = i + 1;
      if (palavras[j] === 'feira') usadas.add(j++);
      if (palavras[j] === 'que' && palavras[j + 1] === 'vem') usadas.add(j).add(j + 1);
      if (i > 0 && /^proxim[ao]$/.test(palavras[i - 1]!)) usadas.add(i - 1);
      continue;
    }
    const barra = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(p);
    if (barra) {
      const dia = Number(barra[1]);
      const mes = Number(barra[2]);
      let ano = barra[3] ? Number(barra[3]) : hoje.getFullYear();
      if (ano < 100) ano += 2000;
      let d = new Date(ano, mes - 1, dia);
      if (!barra[3] && d < hoje) d = new Date(ano + 1, mes - 1, dia);
      if (d.getMonth() === mes - 1 && d.getDate() === dia) {
        data = d;
        usadas.add(i);
      }
      continue;
    }
    if (p === 'dia' && prox && /^\d{1,2}$/.test(prox)) {
      const dia = Number(prox);
      usadas.add(i).add(i + 1);
      let mes: number | undefined;
      const nomeMes = palavras[i + 3];
      if (palavras[i + 2] === 'de' && nomeMes && nomeMes in MESES) {
        mes = MESES[nomeMes];
        usadas.add(i + 2).add(i + 3);
      }
      let d =
        mes !== undefined
          ? new Date(hoje.getFullYear(), mes - 1, dia)
          : new Date(hoje.getFullYear(), hoje.getMonth(), dia);
      if (d < hoje) {
        d =
          mes !== undefined
            ? new Date(hoje.getFullYear() + 1, mes - 1, dia)
            : new Date(hoje.getFullYear(), hoje.getMonth() + 1, dia);
      }
      data = d;
      continue;
    }

    // ---- hora ----
    if (p === 'meio' && prox === 'dia') {
      hora = '12:00';
      usadas.add(i).add(i + 1);
      if (i > 0 && (palavras[i - 1] === 'ao' || palavras[i - 1] === 'as')) usadas.add(i - 1);
      continue;
    }
    const h = /^(\d{1,2})(?:h|hs|hrs|:)(\d{2})?$/.exec(p);
    if (h) {
      const v = hhmm(Number(h[1]), Number(h[2] ?? 0));
      if (v) {
        usadas.add(i);
        if (i > 0 && (palavras[i - 1] === 'as' || palavras[i - 1] === 'a')) usadas.add(i - 1);
        hora = ajustarPeriodo(v, palavras, i + 1, usadas, false);
      }
      continue;
    }
    const n = numero(p);
    if (n !== undefined && n >= 1 && n <= 23) {
      const anterior = i > 0 ? palavras[i - 1] : undefined;
      const marcadoAntes = (anterior === 'as' || anterior === 'a') && !usadas.has(i - 1);
      if (anterior !== 'dia' && (marcadoAntes || periodoOuMeia(palavras, i + 1))) {
        const base = hhmm(n, 0);
        if (base) {
          usadas.add(i);
          if (marcadoAntes) usadas.add(i - 1);
          let k = i + 1;
          if (PALAVRA_HORA.test(palavras[k] ?? '')) usadas.add(k++);
          hora = ajustarPeriodo(base, palavras, k, usadas, true);
        }
      }
    }
  }

  const r: DataHoraLida = { usadas };
  if (data) r.data = paraIsoLocal(data);
  if (hora) r.hora = hora;
  return r;
}

function periodoOuMeia(palavras: string[], k: number): boolean {
  if (PALAVRA_HORA.test(palavras[k] ?? '')) return true;
  if (palavras[k] === 'e' && (palavras[k + 1] === 'meia' || palavras[k + 1] === 'quinze')) return true;
  if ((palavras[k] === 'da' || palavras[k] === 'de') && /^(manha|tarde|noite)$/.test(palavras[k + 1] ?? '')) return true;
  return false;
}

/**
 * Aplica "e meia", "e quinze", "da tarde/noite/manhã" a uma hora lida.
 * Sem período, horas de 1 a 6 viram tarde (ninguém marca às 2 da madrugada numa clínica).
 */
function ajustarPeriodo(base: string, palavras: string[], k: number, usadas: Set<number>, inferir: boolean): string {
  let [h, m] = base.split(':').map(Number) as [number, number];
  if (palavras[k] === 'e' && palavras[k + 1] === 'meia') {
    m = 30;
    usadas.add(k).add(k + 1);
    k += 2;
  } else if (palavras[k] === 'e' && palavras[k + 1] === 'quinze') {
    m = 15;
    usadas.add(k).add(k + 1);
    k += 2;
  }
  let periodo: string | undefined;
  if ((palavras[k] === 'da' || palavras[k] === 'de') && /^(manha|tarde|noite)$/.test(palavras[k + 1] ?? '')) {
    periodo = palavras[k + 1];
    usadas.add(k).add(k + 1);
  }
  if ((periodo === 'tarde' || periodo === 'noite') && h < 12) h += 12;
  if (!periodo && inferir && h >= 1 && h <= 6) h += 12;
  return hhmm(h, m) ?? base;
}

const NOMES_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "hoje", "amanhã" ou "quinta, 15/10". */
export function formatarDia(iso: string, agora: Date): string {
  const d = deIsoLocal(iso);
  const hoje = paraIsoLocal(agora);
  if (iso === hoje) return 'hoje';
  if (iso === paraIsoLocal(somarDias(agora, 1))) return 'amanhã';
  if (iso === paraIsoLocal(somarDias(agora, -1))) return 'ontem';
  return `${NOMES_DIA[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
