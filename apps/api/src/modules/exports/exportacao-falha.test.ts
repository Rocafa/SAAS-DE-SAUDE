/**
 * R2 do parecer do #126: a exportação que cai deixa rastro com motivo GENÉRICO (nunca a mensagem do erro).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { ExitWindowClosedError } from './access-policy';
import { EXPORT_FAILED_AUDIT_SCOPE, ExportsService, motivoDaFalha } from './exports.module';
import { ExportCipherMissingError } from './tenant-export';

const ctx: RequestContext = { tenantId: '00000000-0000-4000-8000-000000000001' as TenantId, userId: '00000000-0000-4000-8000-000000000002' as UserId, roles: ['admin'] };

describe('motivoDaFalha', () => {
  it('traduz para três motivos fixos, sem repetir a mensagem do erro', () => {
    expect(motivoDaFalha(new ExitWindowClosedError())).toBe('janela_de_saida_encerrada');
    expect(motivoDaFalha(new ExportCipherMissingError())).toBe('cifra_ausente');
    expect(motivoDaFalha(new Error('Paciente Fulano CPF 000.000.000-00'))).toBe('erro_interno');
    expect(motivoDaFalha('qualquer coisa')).toBe('erro_interno');
  });
});

describe('ExportsService: falha registrada fora da transação da exportação', () => {
  it('a exportação cai: uma 2ª transação grava só o motivo, e o erro original sobe', async () => {
    const gravados: unknown[] = [];
    const erro = new Error('falha ficticia com dado');
    let chamada = 0;
    const tenantDb = {
      run: vi.fn(async (_t: TenantId, fn: (tx: unknown) => Promise<unknown>) => {
        chamada++;
        if (chamada === 1) throw erro;
        const tx = { insert: () => ({ values: (v: unknown) => (gravados.push(v), Promise.resolve()) }) };
        return fn(tx);
      }),
    };
    const servico = new ExportsService(tenantDb as never, 90, {} as never);
    const registrar = vi.spyOn(servico as unknown as { registrarFalha: (c: RequestContext, r: string) => Promise<void> }, 'registrarFalha');
    await expect(servico.exportTenantData(ctx)).rejects.toBe(erro);
    expect(tenantDb.run).toHaveBeenCalledTimes(2);
    expect(registrar).toHaveBeenCalledWith(ctx, 'erro_interno');
    expect(JSON.stringify(gravados)).not.toContain('falha ficticia');
  });

  it('se nem a linha da falha grava, o erro original é que sobe', async () => {
    const erro = new ExitWindowClosedError();
    const tenantDb = { run: vi.fn().mockRejectedValueOnce(erro).mockRejectedValueOnce(new Error('banco fora')) };
    const servico = new ExportsService(tenantDb as never, 90, {} as never);
    await expect(servico.exportTenantData(ctx)).rejects.toBe(erro);
  });

  it('o escopo da falha é próprio (não se confunde com a exportação bem-sucedida)', () => {
    expect(EXPORT_FAILED_AUDIT_SCOPE).toBe('tenant.full_export_failed');
  });
});

describe('R1 do parecer do #127: a função avulsa (sem rastro de falha) não é usada pela aplicação', () => {
  it('nenhum arquivo de src fora dos testes chama exportTenantData de tenant-export', () => {
    const raiz = join(__dirname, '..', '..');
    const arquivos: string[] = [];
    const andar = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) andar(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) arquivos.push(p);
      }
    };
    andar(raiz);
    const usam = arquivos.filter((p) => !p.endsWith('tenant-export.ts') && /import[^;]*exportTenantData[^;]*from '[^']*tenant-export'/.test(readFileSync(p, 'utf8')));
    expect(usam).toEqual([]);
  });
});
