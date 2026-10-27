/**
 * Trava das listas (sugestão do Guardião, parecer #76): as variáveis/prefixos AWS que a API recusa
 * (`VARIAVEIS_AWS_PROIBIDAS`/`PREFIXOS_AWS_PROIBIDOS`) têm de ser IGUAIS às do Terraform
 * (`api_variaveis_aws_proibidas`/`api_prefixos_aws_proibidos` em infra/terraform/staging/app.tf).
 *
 * O Terraform entrou com o #58: se `app.tf` sumir ou mudar de lugar, o teste FALHA (antes era pulado),
 * para a trava não ficar desligada sem ninguém ver.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PREFIXOS_AWS_PROIBIDOS, VARIAVEIS_AWS_PROIBIDAS } from './kms-client';

const APP_TF = fileURLToPath(new URL('../../../../../infra/terraform/staging/app.tf', pathToFileURL(__filename)));

/** Strings da lista HCL `<nome> = [ ... ]` (ignora comentários `#` e `//`). Lança se a lista não existir. */
function listaDoHcl(hcl: string, nome: string): string[] {
  const semComentarios = hcl.replace(/(^|\s)(#|\/\/).*$/gm, '$1');
  const m = new RegExp(`(?:^|\\s)${nome}\\s*=\\s*\\[([^\\]]*)\\]`).exec(semComentarios);
  if (!m?.[1]) throw new Error(`lista ${nome} não encontrada no HCL`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? '');
}

describe('trava das listas AWS proibidas: API × Terraform', () => {
  it('parser lê listas HCL multilinha com comentários', () => {
    const hcl = [
      '  # api_variaveis_aws_proibidas = ["COMENTADA"]',
      '  api_variaveis_aws_proibidas = [',
      '    "A", "B", # comentário',
      '    "C",',
      '  ]',
      '  api_prefixos_aws_proibidos = ["P"]',
    ].join('\n');
    expect(listaDoHcl(hcl, 'api_variaveis_aws_proibidas')).toEqual(['A', 'B', 'C']);
    expect(listaDoHcl(hcl, 'api_prefixos_aws_proibidos')).toEqual(['P']);
    expect(() => listaDoHcl(hcl, 'outra')).toThrow(/não encontrada/);
  });

  it('app.tf do staging: listas iguais às da API', () => {
    expect(existsSync(APP_TF), `app.tf não encontrado em ${APP_TF}: a trava API × Terraform ficaria sem efeito`).toBe(true);
    const hcl = readFileSync(APP_TF, 'utf8');
    expect(listaDoHcl(hcl, 'api_variaveis_aws_proibidas').sort()).toEqual([...VARIAVEIS_AWS_PROIBIDAS].sort());
    expect(listaDoHcl(hcl, 'api_prefixos_aws_proibidos').sort()).toEqual([...PREFIXOS_AWS_PROIBIDOS].sort());
  });
});
