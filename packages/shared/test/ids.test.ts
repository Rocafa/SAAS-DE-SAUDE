import { describe, expect, it } from 'vitest';
import { tipoId, type PacienteId, type ProfissionalId } from '../src/ids.js';

describe('ids: tipos brandados (nominal typing)', () => {
  it('tipoId cria marca de tipo única', () => {
    const Paciente = tipoId<'Paciente'>();
    const Profissional = tipoId<'Profissional'>();
    const p = Paciente('pac-123');
    const pr = Profissional('prof-456');
    expect(p).toBe('pac-123');
    expect(pr).toBe('prof-456');
  });

  it('IDs de tipos diferentes não são atribuíveis entre si', () => {
    const Paciente = tipoId<'Paciente'>();
    const Profissional = tipoId<'Profissional'>();
    const p: PacienteId = Paciente('pac-123');
    const pr: ProfissionalId = Profissional('prof-456');
    // @ts-expect-error: PacienteId não é atribuível a ProfissionalId
    void (p as ProfissionalId);
    // @ts-expect-error: ProfissionalId não é atribuível a PacienteId
    void (pr as PacienteId);
  });

  it('IDs do mesmo tipo são atribuíveis', () => {
    const Paciente = tipoId<'Paciente'>();
    const p1: PacienteId = Paciente('pac-1');
    const p2: PacienteId = Paciente('pac-2');
    const p3: PacienteId = p2;
    expect(p3).toBe(p2);
    void Paciente;
    void p1;
  });

  it('string pura não é atribuível a ID brandado', () => {
    const Paciente = tipoId<'Paciente'>();
    // @ts-expect-error: string não é atribuível a PacienteId
    void (('pac-123') as PacienteId);
    void Paciente;
  });

  it('IDs brandados aceitam string no construtor', () => {
    const Paciente = tipoId<'Paciente'>();
    const id: PacienteId = Paciente('pac-123');
    expect(id).toBe('pac-123');
  });
});