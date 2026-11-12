/** R9 do parecer do desenho Better Auth: scrypt com os parâmetros da OWASP e conferência em tempo constante. */
import { describe, expect, it } from 'vitest';
import { conferirSenha, gerarHashDeSenha, PARAMETROS_SCRYPT } from './senha';

describe('hash de senha (scrypt, OWASP)', () => {
  it('usa N=2^16, r=8, p=2, e o hash não contém a senha', async () => {
    const hash = await gerarHashDeSenha('Senha-Ficticia-123!');
    expect(hash).toMatch(/^scrypt\$65536\$8\$2\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain('Senha-Ficticia');
    expect(PARAMETROS_SCRYPT).toEqual({ N: 65536, r: 8, p: 2 });
  });

  it('confere a senha certa e recusa a errada; o mesmo texto gera hashes diferentes (sal)', async () => {
    const a = await gerarHashDeSenha('Senha-Ficticia-123!');
    const b = await gerarHashDeSenha('Senha-Ficticia-123!');
    expect(a).not.toBe(b);
    expect(await conferirSenha({ hash: a, password: 'Senha-Ficticia-123!' })).toBe(true);
    expect(await conferirSenha({ hash: a, password: 'senha-ficticia-123!' })).toBe(false);
  });

  it('hash adulterado ou com parâmetros fora da faixa é recusado sem calcular nada caro', async () => {
    const a = await gerarHashDeSenha('Senha-Ficticia-123!');
    expect(await conferirSenha({ hash: a.replace('$65536$', '$1048576000$'), password: 'Senha-Ficticia-123!' })).toBe(false);
    expect(await conferirSenha({ hash: a.replace('$65536$', '$1024$'), password: 'Senha-Ficticia-123!' })).toBe(false);
    expect(await conferirSenha({ hash: 'bcrypt$qualquer', password: 'x' })).toBe(false);
    expect(await conferirSenha({ hash: '', password: '' })).toBe(false);
  });
});
