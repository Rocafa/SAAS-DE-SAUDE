import { describe, expect, it } from 'vitest';
import { tipoId, type PatientId, type ProfessionalId } from '../src/ids.js';

describe('ids: tipos brandados (nominal typing)', () => {
  it('tipoId cria marca de tipo única', () => {
    const Paciente = tipoId<'PatientId'>();
    const Profissional = tipoId<'ProfessionalId'>();
    const p = Paciente('pac-123');
    const pr = Profissional('prof-456');
    expect(p).toBe('pac-123');
    expect(pr).toBe('prof-456');
  });

  it('IDs de tipos diferentes não são atribuíveis entre si', () => {
    const Paciente = tipoId<'PatientId'>();
    const Profissional = tipoId<'ProfessionalId'>();
    const p: PatientId = Paciente('pac-123');
    const pr: ProfessionalId = Profissional('prof-456');
    // @ts-expect-error: PatientId não é atribuível a ProfessionalId
    void (p as ProfessionalId);
    // @ts-expect-error: ProfessionalId não é atribuível a PatientId
    void (pr as PatientId);
  });

  it('IDs do mesmo tipo são atribuíveis', () => {
    const Paciente = tipoId<'PatientId'>();
    const p1: PatientId = Paciente('pac-1');
    const p2: PatientId = Paciente('pac-2');
    const p3: PatientId = p2;
    expect(p3).toBe(p2);
    void Paciente;
    void p1;
  });

  it('string pura não é atribuível a ID brandado', () => {
    const Paciente = tipoId<'PatientId'>();
    // @ts-expect-error: string não é atribuível a PatientId
    const id: PatientId = 'pac-123';
    void id;
    void Paciente;
  });

  it('IDs brandados aceitam string no construtor', () => {
    const Paciente = tipoId<'PatientId'>();
    const id: PatientId = Paciente('pac-123');
    expect(id).toBe('pac-123');
  });
});