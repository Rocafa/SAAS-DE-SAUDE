/**
 * Acha cores com matiz (não cinza) num texto CSS. Usado pelo build (scripts/checar-cinza.mjs)
 * e pelos testes. Cinza = vermelho, verde e azul iguais (ou croma zero nos espaços OKLCH/LAB).
 */

const NOMEADAS = [
  'aliceblue', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'blanchedalmond', 'blue', 'blueviolet', 'brown',
  'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan',
  'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgreen', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange',
  'darkorchid', 'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dodgerblue', 'firebrick', 'forestgreen', 'fuchsia', 'gold', 'goldenrod', 'green', 'greenyellow',
  'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lawngreen', 'lemonchiffon', 'lightblue',
  'lightcoral', 'lightcyan', 'lightgreen', 'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue',
  'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumblue', 'mediumorchid',
  'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred',
  'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab',
  'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip',
  'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue',
  'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'skyblue', 'slateblue', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'yellow', 'yellowgreen',
  'highlight', 'linktext', 'visitedtext', 'activetext', 'accentcolor', 'mark',
];

const PERTO = 0.004;

function numeros(args) {
  return args
    .replace(/\/.*$/, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => (x === 'none' ? 0 : parseFloat(x)));
}

function iguais(a, b, c) {
  return Math.abs(a - b) < 0.6 && Math.abs(b - c) < 0.6;
}

/** @param {string} css @returns {string[]} */
export function coresNaoCinza(css) {
  const achadas = [];
  // Ignora comentários e strings (ex.: content: "azul").
  const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  for (const m of limpo.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    const h = m[1];
    if (![3, 4, 6, 8].includes(h.length)) continue;
    const curto = h.length <= 4;
    const r = curto ? h[0] + h[0] : h.slice(0, 2);
    const g = curto ? h[1] + h[1] : h.slice(2, 4);
    const b = curto ? h[2] + h[2] : h.slice(4, 6);
    if (!(r.toLowerCase() === g.toLowerCase() && g.toLowerCase() === b.toLowerCase())) achadas.push(m[0]);
  }

  for (const m of limpo.matchAll(/\b(rgba?|hsla?|oklch|lch|oklab|lab|hwb|color)\(([^()]*)\)/gi)) {
    const fn = m[1].toLowerCase();
    const args = m[2];
    if (/var\(|from\b/.test(args)) continue;
    let ok = true;
    if (fn === 'rgb' || fn === 'rgba') {
      const [r, g, b] = numeros(args.replace(/%/g, ''));
      ok = iguais(r, g, b);
    } else if (fn === 'hsl' || fn === 'hsla') {
      const [, s, l] = numeros(args.replace(/deg|%/g, ''));
      ok = s === 0 || l === 0 || l === 100;
    } else if (fn === 'oklch' || fn === 'lch') {
      const [, c] = numeros(args.replace(/%/g, ''));
      ok = Math.abs(c) <= (fn === 'lch' ? 0.5 : PERTO);
    } else if (fn === 'oklab' || fn === 'lab') {
      const [, a, b] = numeros(args.replace(/%/g, ''));
      const lim = fn === 'lab' ? 0.5 : PERTO;
      ok = Math.abs(a) <= lim && Math.abs(b) <= lim;
    } else if (fn === 'hwb') {
      const [, w, bl] = numeros(args.replace(/deg|%/g, ''));
      ok = w + bl >= 100;
    } else if (fn === 'color') {
      const partes = args.trim().split(/\s+/);
      const [r, g, b] = numeros(partes.slice(1).join(' '));
      ok = iguais(r * 255, g * 255, b * 255);
    }
    if (!ok) achadas.push(m[0]);
  }

  const reNome = new RegExp(`(?<![\\w-])(${NOMEADAS.join('|')})(?![\\w-])`, 'gi');
  for (const decl of limpo.matchAll(/:([^;{}]*)[;}]/g)) {
    const valor = decl[1];
    if (/^\s*(is|where|not|has|hover|focus|root|before|after|nth|first|last|active)\b/i.test(valor)) continue;
    for (const n of valor.matchAll(reNome)) achadas.push(n[1]);
  }
  return achadas;
}

/** Contraste WCAG entre duas cores hexadecimais. */
export function contraste(hex1, hex2) {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(hex1), lum(hex2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
