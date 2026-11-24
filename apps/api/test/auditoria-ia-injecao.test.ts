import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PSEUDONYM_SIGNER } from '../src/modules/audit/ator-suporte';
import { AuditoriaIaService, RELOGIO_IA, RELOGIO_MONOTONICO_IA } from '../src/modules/audit/registro-ia';
import { TenantDatabase } from '../src/modules/tenancy/tenancy.module';
import { signerDeTeste } from './apoio-auditoria-ia';

/**
 * O transpilador do vitest não emite `design:paramtypes`; o `tsc` do build emite. Sem isso, um
 * parâmetro sem token (ex.: `clock: () => Date`) passa aqui e só quebra no boot do `dist/`.
 * Reproduzimos o que o `tsc` emite para esse construtor: (TenantDatabase, Object, Function, Function)
 * — o signer é uma interface, que vira `Object`, e por isso precisa do token PSEUDONYM_SIGNER.
 */
function comMetadadosDoTsc(): void {
  if (!Reflect.hasOwnMetadata('design:paramtypes', AuditoriaIaService)) {
    Reflect.defineMetadata('design:paramtypes', [TenantDatabase, Object, Function, Function], AuditoriaIaService);
  }
}

const signer = { provide: PSEUDONYM_SIGNER, useValue: signerDeTeste() };

describe('AuditoriaIaService no contêiner do Nest', () => {
  it('resolve só com TenantDatabase e o signer (relógios são opcionais)', async () => {
    comMetadadosDoTsc();
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: TenantDatabase, useValue: {} }, signer, AuditoriaIaService],
    }).compile();
    expect(moduleRef.get(AuditoriaIaService)).toBeInstanceOf(AuditoriaIaService);
    await moduleRef.close();
  });

  it('não sobe sem o signer: hash da trilha sem chave não é opção', async () => {
    comMetadadosDoTsc();
    await expect(
      Test.createTestingModule({ providers: [{ provide: TenantDatabase, useValue: {} }, AuditoriaIaService] }).compile(),
    ).rejects.toThrow();
  });

  it('aceita relógios injetados pelos tokens', async () => {
    comMetadadosDoTsc();
    const agora = () => new Date('2026-01-01T00:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: TenantDatabase, useValue: {} },
        signer,
        { provide: RELOGIO_IA, useValue: agora },
        { provide: RELOGIO_MONOTONICO_IA, useValue: () => 0 },
        AuditoriaIaService,
      ],
    }).compile();
    const servico = moduleRef.get<AuditoriaIaService, { clock: () => Date }>(AuditoriaIaService);
    expect(servico.clock).toBe(agora);
    await moduleRef.close();
  });
});
