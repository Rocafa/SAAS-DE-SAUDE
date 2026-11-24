/**
 * Código de demonstração das telas de acesso (entrar, convite da clínica e entrada do portal) e da
 * exportação de dados em Configurações. Vale SÓ em modo `fake`: em modo `http` nenhuma dessas telas aceita
 * o código, mesmo num build de desenvolvimento. Este é o único arquivo de `apps/web` onde a sequência do
 * código aparece (o teste `acesso-demonstracao.test.ts` confere isso). O valor é fictício, não é segredo.
 */
export const CODIGO_DE_DEMONSTRACAO = '123456';

export type ModoAcesso = 'fake' | 'http';

/**
 * `modo` vem de `lerConfigApi().modo` (clínica) ou de `lerConfigPortal().modo` (portal): quem lê o modo é o
 * adaptador, não este módulo. Não importa `selecionar.ts` aqui para evitar ciclo com `fake.ts`.
 */
export function codigoDeDemonstracaoAceito(codigo: string, modo: ModoAcesso): boolean {
  return modo === 'fake' && codigo.replace(/\s/g, '') === CODIGO_DE_DEMONSTRACAO;
}
