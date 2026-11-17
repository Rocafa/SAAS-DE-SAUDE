/**
 * Datas dos testes no fuso da CLÍNICA, o mesmo do navegador (`timezoneId` em playwright.config.ts).
 * O `new Date()` do Node usa o fuso da máquina: no CI (UTC), entre 21h e 0h de Brasília o Node já está no dia
 * seguinte e o teste procura a agenda no dia errado.
 */
export const FUSO_DA_CLINICA = 'America/Sao_Paulo';

/** Dia de hoje (AAAA-MM-DD) no fuso da clínica. */
export function hojeIso(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_CLINICA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

/** Próxima quinta-feira depois de hoje (nunca hoje), no fuso da clínica. */
export function proximaQuinta(agora: Date = new Date()): string {
  const d = new Date(`${hojeIso(agora)}T12:00:00Z`);
  const delta = (4 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
