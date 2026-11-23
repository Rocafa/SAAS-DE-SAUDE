import { describe, expect, it } from 'vitest';
import { deveLacrar, type SinaisDoAutor } from './ciclo-notas-privadas';

/** Parecer do Guardião no #229: lacrar × eliminar é irreversível, então na dúvida lacra. */
const semSinalDoBanco = (especialidades: string[] | null): SinaisDoAutor => ({ especialidades, areaSensivel: false, perfilPsicologo: false });

describe('ciclo das notas privadas: lacrar na dúvida (deveLacrar)', () => {
  it.each(['Psicomotricidade', 'Psicopedagogia', 'Psicol.', 'Psicól. clínica', 'Psicooncologia', 'Psicodrama', 'Psicodramatista', 'Psicóloga clínica'])(
    'autor "%s" sem sinal no banco: lacra, não elimina',
    (especialidade) => {
      expect(deveLacrar(semSinalDoBanco([especialidade]))).toBe(true);
    },
  );

  it('fisio e TO sem sinal no banco: eliminação (regra D2 inalterada)', () => {
    expect(deveLacrar(semSinalDoBanco(['Fisioterapia']))).toBe(false);
    expect(deveLacrar(semSinalDoBanco(['Terapia Ocupacional']))).toBe(false);
    expect(deveLacrar(semSinalDoBanco(null))).toBe(false);
  });

  it('sinal do banco vence a especialidade: perfil psicologo ou área sensível lacram', () => {
    expect(deveLacrar({ especialidades: ['Fisioterapia'], areaSensivel: false, perfilPsicologo: true })).toBe(true);
    expect(deveLacrar({ especialidades: ['Fisioterapia'], areaSensivel: true, perfilPsicologo: false })).toBe(true);
    expect(deveLacrar({ especialidades: null, areaSensivel: false, perfilPsicologo: true })).toBe(true);
  });

  it('autor desligado, especialidade sem "psico", sem área sensível, só o perfil psicologo (já revogado): lacra', () => {
    // perfilPsicologo vem do histórico de clinic_members (revogado conta); o RLS do ciclo prova a consulta.
    expect(deveLacrar({ especialidades: ['Terapia integrativa'], areaSensivel: false, perfilPsicologo: true })).toBe(true);
    expect(deveLacrar({ especialidades: ['Terapia integrativa'], areaSensivel: false, perfilPsicologo: false })).toBe(false);
  });

  it('autor com dois cadastros: basta um ser área psi', () => {
    expect(deveLacrar(semSinalDoBanco(['Fisioterapia', 'Psicol.']))).toBe(true);
  });
});
