import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AuditoriaIaService, RELOGIO_IA, RELOGIO_MONOTONICO_IA } from '../src/modules/audit/registro-ia';
import { TenantDatabase } from '../src/modules/tenancy/tenancy.module';

/**
 * O transpilador do vitest não emite `design:paramtypes`; o `tsc` do build emite. Sem isso, um
 * parâmetro sem token (ex.: `clock: () => Date`) passa aqui e só quebra no boot do `dist/`.
 * Reproduzimos o que o `tsc` emite para esse construtor: (TenantDatabase, Function, Function).
 */
function comMetadadosDoTsc(): void {
  if (!Reflect.hasOwnMetadata('design:paramtypes', AuditoriaIaService)) {
    Reflect.defineMetadata('design:paramtypes', [TenantDatabase, Function, Function], AuditoriaIaService);
  }
}

describe('AuditoriaIaService no contêiner do Nest', () => {
  it('resolve só com TenantDatabase (relógios são opcionais)', async () => {
    comMetadadosDoTsc();
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: TenantDatabase, useValue: {} }, AuditoriaIaService],
    }).compile();
    expect(moduleRef.get(AuditoriaIaService)).toBeInstanceOf(AuditoriaIaService);
    await moduleRef.close();
  });

  it('aceita relógios injetados pelos tokens', async () => {
    comMetadadosDoTsc();
    const agora = () => new Date('2026-01-01T00:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: TenantDatabase, useValue: {} },
        { provide: RELOGIO_IA, useValue: agora },
        { provide: RELOGIO_MONOTONICO_IA, useValue: () => 0 },
        AuditoriaIaService,
      ],
    }).compile();
    const servico = moduleRef.get(AuditoriaIaService) as unknown as { clock: () => Date };
    expect(servico.clock).toBe(agora);
    await moduleRef.close();
  });
});
