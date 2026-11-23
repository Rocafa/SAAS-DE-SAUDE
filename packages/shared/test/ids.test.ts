import { describe, it } from 'vitest';
import type { PatientId, ProfessionalId } from '../src/ids.js';

// Estes testes só valem no typecheck (tsconfig.test.json, rodado por `pnpm typecheck`):
// cada @ts-expect-error falha se o branding deixar de barrar a troca de IDs.
describe('ids: tipos brandados (nominal typing)', () => {
  it('ID de um tipo não é atribuível a outro tipo de ID', () => {
    const paciente = 'pac-123' as PatientId;
    const profissional = 'prof-456' as ProfessionalId;

    // @ts-expect-error: PatientId não é atribuível a ProfessionalId
    const comoProfissional: ProfessionalId = paciente;
    // @ts-expect-error: ProfessionalId não é atribuível a PatientId
    const comoPaciente: PatientId = profissional;

    void comoProfissional;
    void comoPaciente;
  });

  it('string pura não é atribuível a ID brandado', () => {
    // @ts-expect-error: string não é atribuível a PatientId
    const id: PatientId = 'pac-123';
    void id;
  });

  it('ID brandado continua atribuível a string', () => {
    const paciente = 'pac-123' as PatientId;
    const texto: string = paciente;
    void texto;
  });
});
