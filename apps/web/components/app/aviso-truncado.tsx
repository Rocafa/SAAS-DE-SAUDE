/**
 * Aviso discreto quando a lista de pacientes parou no teto de 1.000 nomes (`truncado` do adaptador).
 * Texto fixo: nunca mostra nome, contagem exata nem termo buscado.
 */
export function AvisoTruncado({ truncado }: { truncado?: boolean }) {
  if (!truncado) return null;
  return (
    <p role="status" className="mb-4 text-[0.95rem] text-texto-suave">
      Mostrando os primeiros 1.000 — refine a busca
    </p>
  );
}
