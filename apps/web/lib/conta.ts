/**
 * Regras da conta da clínica (sem tela, testadas no Vitest): janela de saída depois do
 * cancelamento (G3), avisos antes do fim, validação de acesso e passos do primeiro uso.
 */
import { deIsoLocal, paraIsoLocal, somarDias } from './ajudante/datas';

/** Garantia G3: depois de cancelar, leitura e exportação por no mínimo 90 dias. */
export const JANELA_SAIDA_DIAS = 90;

export function fimDaJanela(canceladoEm: string): string {
  return paraIsoLocal(somarDias(deIsoLocal(canceladoEm), JANELA_SAIDA_DIAS));
}

export function diasRestantes(ate: string, hoje: Date): number {
  return Math.round((deIsoLocal(ate).getTime() - deIsoLocal(paraIsoLocal(hoje)).getTime()) / 864e5);
}

/** Avisos de D-30, D-7 e D-1 antes do fim da janela de saída. */
export function avisoDeSaida(canceladoEm: string, hoje: Date): string | null {
  const resta = diasRestantes(fimDaJanela(canceladoEm), hoje);
  if (resta < 0) return null;
  if (resta <= 1) return 'Último dia para baixar os dados da clínica. Depois disso eles são eliminados com certificado.';
  if (resta <= 7) return `Faltam ${resta} dias para o fim do prazo. Baixe os dados da clínica.`;
  if (resta <= 30) return `Faltam ${resta} dias para o fim do prazo para baixar os dados.`;
  return null;
}

export function validarEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return 'Falta o e-mail.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'E-mail incompleto. Confira se tem @ e o final (ex.: .com.br).';
  return null;
}

/** Regras de senha mostradas antes de a pessoa errar, não depois. */
export const REGRAS_SENHA = [
  { id: 'tamanho', texto: 'Pelo menos 12 letras ou números', ok: (s: string) => s.length >= 12 },
  { id: 'letra', texto: 'Pelo menos uma letra', ok: (s: string) => /\p{L}/u.test(s) },
  { id: 'numero', texto: 'Pelo menos um número', ok: (s: string) => /\d/.test(s) },
] as const;

export function errosSenha(senha: string, confirmacao?: string): string[] {
  const out = REGRAS_SENHA.filter((r) => !r.ok(senha)).map((r) => `Falta: ${r.texto.toLowerCase()}.`);
  if (confirmacao !== undefined && senha !== confirmacao) out.push('As duas senhas estão diferentes. Digite de novo.');
  return out;
}

export function validarCodigo(codigo: string): string | null {
  const d = codigo.replace(/\s/g, '');
  if (!d) return 'Falta o código. Ele aparece no aplicativo autenticador do seu celular.';
  if (!/^\d{6}$/.test(d)) return 'O código tem 6 números.';
  return null;
}

export const PASSOS_PRIMEIRO_USO = [
  { id: 'clinica', titulo: 'Sua clínica' },
  { id: 'profissionais', titulo: 'Quem atende' },
  { id: 'horarios', titulo: 'Horários' },
  { id: 'tipos', titulo: 'Tipos de atendimento' },
  { id: 'importar', titulo: 'Trazer dados do sistema antigo' },
] as const;

/**
 * Tempo sem uso até sair sozinho (requisitos §3: 15 min para perfil clínico em estação
 * compartilhada). Configurável por clínica quando a API real entrar.
 */
export const TEMPO_SESSAO_MINUTOS = 15;
