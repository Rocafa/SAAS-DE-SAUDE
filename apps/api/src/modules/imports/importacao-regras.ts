import { createHash } from 'node:crypto';
import { ehDataValida, ehHoraValida } from '../../common/validacao';
import { nascimentoValido, normalizarBusca, normalizarCpf, normalizarTelefone } from '../patients/patients.validation';
import type { ImportKind } from '../../db/schema';
import { neutralizarFormula, pareceFormula, type Planilha } from './planilha-csv';

/**
 * Regras puras do importador (sem banco): campos por tipo de lote, sugestão de mapeamento, validação linha a
 * linha com as MESMAS regras do cadastro de pacientes e da agenda (CPF com DV, telefone brasileiro,
 * nascimento entre 1900 e hoje, data/hora da agenda), duplicados dentro do arquivo e o hash do plano.
 */

/** Versão vigente do termo de migração (MIG-02.4). Trocar a versão exige novo aceite. */
export const TERMO_MIGRACAO_VERSAO = 'mig-02.4-v1';

/**
 * Colunas do RESPONSÁVEL no lote de pacientes (R5 do parecer do importador, migração 0048). Opcionais; se
 * alguma for mapeada, `responsavelNome` e `responsavelTipo` também têm de ser.
 */
export const CAMPOS_RESPONSAVEL = [
  'responsavelNome',
  'responsavelCpf',
  'responsavelTelefone',
  'responsavelTipo',
  'responsavelPagador',
  'responsavelCuratelaReferencia',
  'responsavelCuratelaEscopo',
] as const;

export const CAMPOS: Readonly<Record<ImportKind, readonly string[]>> = {
  pacientes: ['nome', 'nomeSocial', 'cpf', 'telefone', 'nascimento', ...CAMPOS_RESPONSAVEL],
  agenda: ['cpf', 'paciente', 'data', 'hora', 'profissional', 'tipo'],
};
export const OBRIGATORIOS: Readonly<Record<ImportKind, readonly string[]>> = {
  pacientes: ['nome', 'telefone'],
  agenda: ['data', 'hora', 'profissional', 'tipo'],
};

/** Cabeçalhos usuais (sem acento, minúsculas) -> campo. Só sugestão: o admin confirma o mapeamento. */
const SINONIMOS: Readonly<Record<ImportKind, Readonly<Record<string, readonly string[]>>>> = {
  pacientes: {
    nome: ['nome', 'nome completo', 'paciente', 'nome do paciente', 'nome paciente'],
    nomeSocial: ['nome social'],
    cpf: ['cpf', 'cpf do paciente', 'documento'],
    telefone: ['telefone', 'celular', 'fone', 'whatsapp', 'telefone celular', 'contato'],
    nascimento: ['nascimento', 'data de nascimento', 'data nascimento', 'dt nascimento', 'dt. nascimento'],
    responsavelNome: ['responsavel', 'nome do responsavel', 'responsavel nome', 'nome responsavel', 'responsavel legal'],
    responsavelCpf: ['cpf do responsavel', 'cpf responsavel', 'responsavel cpf'],
    responsavelTelefone: ['telefone do responsavel', 'telefone responsavel', 'celular do responsavel', 'responsavel telefone'],
    responsavelTipo: ['tipo do responsavel', 'tipo responsavel', 'parentesco', 'vinculo', 'vinculo do responsavel'],
    responsavelPagador: ['responsavel pagador', 'pagador', 'responsavel financeiro', 'e pagador'],
    responsavelCuratelaReferencia: ['decisao judicial', 'referencia da decisao', 'processo da curatela', 'curatela referencia'],
    responsavelCuratelaEscopo: ['escopo da curatela', 'curatela escopo'],
  },
  agenda: {
    cpf: ['cpf', 'cpf do paciente'],
    paciente: ['paciente', 'nome', 'nome do paciente', 'nome paciente'],
    data: ['data', 'dia', 'data do agendamento', 'data da consulta'],
    hora: ['hora', 'horario', 'hora inicio', 'inicio'],
    profissional: ['profissional', 'medico', 'terapeuta', 'responsavel', 'nome do profissional'],
    tipo: ['tipo', 'tipo de atendimento', 'servico', 'procedimento', 'atendimento'],
  },
};

export type Mapeamento = Readonly<Record<string, number>>;

export function sugerirMapeamento(kind: ImportKind, cabecalho: readonly string[]): Mapeamento {
  const normal = cabecalho.map((h) => normalizarBusca(h));
  const out: Record<string, number> = {};
  const usados = new Set<number>();
  for (const campo of CAMPOS[kind]) {
    const idx = normal.findIndex((h, i) => !usados.has(i) && (SINONIMOS[kind][campo] ?? []).includes(h));
    if (idx >= 0) {
      out[campo] = idx;
      usados.add(idx);
    }
  }
  return out;
}

/** Confere o mapeamento contra o tipo e o número de colunas; devolve os campos com problema. */
export function errosDoMapeamento(kind: ImportKind, mapa: Mapeamento, colunas: number): string[] {
  const erros: string[] = [];
  const indices = new Set<number>();
  for (const [campo, idx] of Object.entries(mapa)) {
    if (!CAMPOS[kind].includes(campo) || !Number.isInteger(idx) || idx < 0 || idx >= colunas || indices.has(idx)) erros.push(campo);
    indices.add(idx);
  }
  for (const campo of OBRIGATORIOS[kind]) if (!(campo in mapa)) erros.push(campo);
  // Agenda: o paciente vem pelo CPF ou, sem CPF, pelo nome exato.
  if (kind === 'agenda' && !('cpf' in mapa) && !('paciente' in mapa)) erros.push('paciente');
  // Responsável: qualquer coluna dele exige o nome e o tipo mapeados.
  if (kind === 'pacientes' && CAMPOS_RESPONSAVEL.some((c) => c in mapa)) {
    for (const c of ['responsavelNome', 'responsavelTipo']) if (!(c in mapa)) erros.push(c);
  }
  return [...new Set(erros)];
}

export type Gravidade = 'erro' | 'aviso';

export interface Divergencia {
  readonly linha: number;
  readonly campo: string;
  readonly codigo: string;
  readonly gravidade: Gravidade;
}

/** Tipo do responsável aceito pela planilha (o cadastro tem também `representante`, só pela tela). */
export type TipoResponsavelImportado = 'pai_mae' | 'tutor' | 'curador';

/**
 * Responsável da linha que VAI virar vínculo (já passou nas regras: menor para pai/mãe e tutor; curatela de
 * maior com a decisão e o escopo). A marca clínica nunca vem da planilha (decisão do profissional).
 */
export interface ResponsavelDaLinha {
  readonly nome: string;
  readonly cpf?: string;
  readonly telefone?: string;
  readonly tipo: TipoResponsavelImportado;
  /** Só para paciente menor (para adulto o cadastro exige a ciência dele, A7 do #67). */
  readonly pagador: boolean;
  readonly curatela?: { readonly referencia: string; readonly escopo: string };
}

export interface PacienteDaLinha {
  readonly linha: number;
  readonly nome: string;
  readonly nomeSocial?: string;
  readonly cpf?: string;
  readonly telefone: string;
  readonly nascimento?: string;
  readonly responsavel?: ResponsavelDaLinha;
}

export interface AgendamentoDaLinha {
  readonly linha: number;
  readonly cpf?: string;
  readonly paciente?: string;
  readonly data: string;
  readonly hora: string;
  readonly profissional: string;
  readonly tipo: string;
}

export interface Validacao<T> {
  readonly validas: readonly T[];
  readonly divergencias: readonly Divergencia[];
  readonly linhasComErro: number;
}

/** Data da planilha: AAAA-MM-DD ou DD/MM/AAAA (também com `-` ou `.`). Devolve AAAA-MM-DD ou undefined. */
export function lerData(valor: string): string | undefined {
  const v = valor.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return ehDataValida(v) ? v : undefined;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (!m) return undefined;
  const iso = `${m[3]}-${(m[2] as string).padStart(2, '0')}-${(m[1] as string).padStart(2, '0')}`;
  return ehDataValida(iso) ? iso : undefined;
}

/** Hora HH:MM (aceita H:MM e HH:MM:SS com segundos zerados). */
export function lerHora(valor: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(valor.trim());
  if (!m) return undefined;
  const h = `${(m[1] as string).padStart(2, '0')}:${m[2]}`;
  return ehHoraValida(h) ? h : undefined;
}

function temControle(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** Texto livre (nome): limpa espaços; recusa fórmula (CWE-1236) e caractere de controle. */
function texto(valor: string, max: number): { valor?: string; codigo?: string } {
  if (pareceFormula(valor)) return { codigo: 'formula_na_celula' };
  const t = valor.normalize('NFC').trim().replace(/\s{2,}/g, ' ');
  if (t.length === 0) return {};
  if (t.length > max || temControle(t)) return { codigo: 'texto_invalido' };
  return { valor: t };
}

/** Menor de 18 anos em `hoje` (data UTC), pelo nascimento AAAA-MM-DD já validado. */
export function ehMenorDeIdade(nascimento: string, hoje: Date): boolean {
  const ano = Number(nascimento.slice(0, 4)) + 18;
  return hoje.toISOString().slice(0, 10) < `${ano}${nascimento.slice(4)}`;
}

function celula(celulas: readonly string[], mapa: Mapeamento, campo: string): string {
  const idx = mapa[campo];
  return idx === undefined ? '' : (celulas[idx] ?? '');
}

const TIPOS_RESPONSAVEL: Readonly<Record<string, TipoResponsavelImportado>> = {
  pai: 'pai_mae',
  mae: 'pai_mae',
  'pai/mae': 'pai_mae',
  'pai ou mae': 'pai_mae',
  pai_mae: 'pai_mae',
  'pai e mae': 'pai_mae',
  tutor: 'tutor',
  tutora: 'tutor',
  'tutor(a)': 'tutor',
  curador: 'curador',
  curadora: 'curador',
  'curador(a)': 'curador',
};
const SIM = new Set(['sim', 's', 'x', '1', 'true', 'verdadeiro', 'yes']);
const NAO = new Set(['nao', 'n', '0', 'false', 'falso', 'no']);

/**
 * Responsável da linha (R5): devolve o responsável que vira vínculo, ou nenhum, e os avisos. Nada aqui tira o
 * PACIENTE da importação: problema no responsável é aviso e o vínculo não é criado (o paciente menor continua
 * com `menor_sem_responsavel`, e a recepção completa no cadastro).
 * - pai/mãe e tutor: só para paciente MENOR pela data de nascimento (sem data: não se presume);
 * - curador: só para paciente maior, com a referência da decisão judicial E o escopo (A3 do #67);
 * - pagador: só para menor (adulto exige a ciência dele, que a planilha não dá: A7 do #67);
 * - sem CPF não há como reconhecer a mesma pessoa (irmãos): aviso, e cada linha cria uma pessoa.
 */
function responsavelDaLinha(
  celulas: readonly string[],
  mapa: Mapeamento,
  numero: number,
  paciente: { cpf?: string; nascimento?: string },
  hoje: Date,
): { responsavel?: ResponsavelDaLinha; avisos: Divergencia[] } {
  const avisos: Divergencia[] = [];
  const aviso = (campo: string, codigo: string) => avisos.push({ linha: numero, campo, codigo, gravidade: 'aviso' });
  const bruto = Object.fromEntries(CAMPOS_RESPONSAVEL.map((c) => [c, celula(celulas, mapa, c).trim()])) as Record<(typeof CAMPOS_RESPONSAVEL)[number], string>;
  if (Object.values(bruto).every((v) => v === '')) return { avisos };
  let ok = true;
  const recusar = (campo: string, codigo: string) => {
    aviso(campo, codigo);
    ok = false;
  };
  const nome = texto(bruto.responsavelNome, 200);
  if (nome.codigo) recusar('responsavelNome', nome.codigo);
  else if (!nome.valor || nome.valor.length < 2) recusar('responsavelNome', 'obrigatorio');
  const cpf = bruto.responsavelCpf ? normalizarCpf(bruto.responsavelCpf) : undefined;
  if (bruto.responsavelCpf && !cpf) recusar('responsavelCpf', pareceFormula(bruto.responsavelCpf) ? 'formula_na_celula' : 'cpf_invalido');
  else if (cpf && cpf === paciente.cpf) recusar('responsavelCpf', 'cpf_do_proprio_paciente');
  const telefone = bruto.responsavelTelefone ? normalizarTelefone(bruto.responsavelTelefone) : undefined;
  if (bruto.responsavelTelefone && !telefone) {
    recusar('responsavelTelefone', pareceFormula(bruto.responsavelTelefone) && !/^\+\d/.test(bruto.responsavelTelefone) ? 'formula_na_celula' : 'telefone_invalido');
  }
  const tipo = bruto.responsavelTipo ? TIPOS_RESPONSAVEL[normalizarBusca(bruto.responsavelTipo).replace(/\s+/g, ' ').trim()] : undefined;
  if (!bruto.responsavelTipo) recusar('responsavelTipo', 'obrigatorio');
  else if (!tipo) recusar('responsavelTipo', 'tipo_invalido');
  const pagadorNormal = normalizarBusca(bruto.responsavelPagador).trim();
  let pagador = false;
  if (pagadorNormal !== '') {
    if (SIM.has(pagadorNormal)) pagador = true;
    else if (!NAO.has(pagadorNormal)) recusar('responsavelPagador', 'valor_invalido');
  }
  const referencia = texto(bruto.responsavelCuratelaReferencia, 300);
  const escopo = texto(bruto.responsavelCuratelaEscopo, 1000);
  if (referencia.codigo) recusar('responsavelCuratelaReferencia', referencia.codigo);
  if (escopo.codigo) recusar('responsavelCuratelaEscopo', escopo.codigo);
  const menor = paciente.nascimento ? ehMenorDeIdade(paciente.nascimento, hoje) : null;
  if (tipo === 'curador') {
    if (menor === true) recusar('responsavelTipo', 'curatela_de_menor');
    else if (!referencia.valor || referencia.valor.length < 3) recusar('responsavelCuratelaReferencia', 'curatela_sem_decisao');
    else if (!escopo.valor || escopo.valor.length < 3) recusar('responsavelCuratelaEscopo', 'curatela_sem_escopo');
  } else if (tipo) {
    if (menor !== true) recusar('responsavelTipo', menor === null ? 'vinculo_sem_data_de_nascimento' : 'vinculo_exige_menor_ou_curatela');
    if (referencia.valor || escopo.valor) aviso('responsavelCuratelaReferencia', 'curatela_ignorada');
  }
  if (!ok || !tipo) {
    aviso('responsavelNome', 'responsavel_nao_importado');
    return { avisos };
  }
  if (pagador && tipo === 'curador') {
    aviso('responsavelPagador', 'pagador_exige_ciencia_do_paciente');
    pagador = false;
  }
  if (!cpf) aviso('responsavelCpf', 'responsavel_sem_cpf');
  return {
    avisos,
    responsavel: {
      nome: nome.valor as string,
      tipo,
      pagador,
      ...(cpf ? { cpf } : {}),
      ...(telefone ? { telefone } : {}),
      ...(tipo === 'curador' ? { curatela: { referencia: referencia.valor as string, escopo: escopo.valor as string } } : {}),
    },
  };
}

/**
 * Valida as linhas de um lote de PACIENTES. Erro tira a linha da importação; aviso não. CPF repetido no
 * arquivo: a primeira ocorrência vale, as seguintes são erro. Mesmo nome + nascimento sem CPF: aviso.
 * Menor de 18 anos pelo nascimento SEM responsável válido na linha: aviso `menor_sem_responsavel` (R5 do
 * parecer do importador); a linha entra e o admin vê, antes de aplicar, quem vai precisar dele. As colunas
 * do responsável (0048) seguem `responsavelDaLinha`.
 */
export function validarPacientes(planilha: Planilha, mapa: Mapeamento, hoje: Date = new Date()): Validacao<PacienteDaLinha> {
  const divergencias: Divergencia[] = [];
  const validas: PacienteDaLinha[] = [];
  const cpfs = new Set<string>();
  const nomeNascimento = new Set<string>();
  const responsaveisNoArquivo = new Map<string, string>();
  let linhasComErro = 0;
  for (const { numero, celulas } of planilha.linhas) {
    const erros: Divergencia[] = [];
    const erro = (campo: string, codigo: string) => erros.push({ linha: numero, campo, codigo, gravidade: 'erro' });
    if (celulas.length !== planilha.cabecalho.length) erro('linha', 'numero_de_colunas');
    const nome = texto(celula(celulas, mapa, 'nome'), 200);
    if (nome.codigo) erro('nome', nome.codigo);
    else if (!nome.valor) erro('nome', 'obrigatorio');
    const social = texto(celula(celulas, mapa, 'nomeSocial'), 200);
    if (social.codigo) erro('nomeSocial', social.codigo);
    const cpfBruto = celula(celulas, mapa, 'cpf').trim();
    const cpf = cpfBruto ? normalizarCpf(cpfBruto) : undefined;
    if (cpfBruto && !cpf) erro('cpf', pareceFormula(cpfBruto) ? 'formula_na_celula' : 'cpf_invalido');
    const telBruto = celula(celulas, mapa, 'telefone').trim();
    const telefone = telBruto ? normalizarTelefone(telBruto) : undefined;
    if (!telBruto) erro('telefone', 'obrigatorio');
    else if (!telefone) erro('telefone', pareceFormula(telBruto) && !/^\+\d/.test(telBruto) ? 'formula_na_celula' : 'telefone_invalido');
    const nascBruto = celula(celulas, mapa, 'nascimento').trim();
    const nascimento = nascBruto ? lerData(nascBruto) : undefined;
    if (nascBruto && (!nascimento || !nascimentoValido(nascimento, hoje))) erro('nascimento', 'data_invalida');
    if (cpf && erros.length === 0) {
      if (cpfs.has(cpf)) erro('cpf', 'cpf_duplicado_no_arquivo');
      else cpfs.add(cpf);
    }
    if (erros.length > 0) {
      linhasComErro++;
      divergencias.push(...erros);
      continue;
    }
    if (!cpf && nascimento && nome.valor) {
      const chave = `${normalizarBusca(nome.valor)}|${nascimento}`;
      if (nomeNascimento.has(chave)) divergencias.push({ linha: numero, campo: 'nome', codigo: 'possivel_duplicado', gravidade: 'aviso' });
      nomeNascimento.add(chave);
    }
    const r = responsavelDaLinha(celulas, mapa, numero, { ...(cpf ? { cpf } : {}), ...(nascimento ? { nascimento } : {}) }, hoje);
    divergencias.push(...r.avisos);
    const responsavel = r.responsavel;
    if (responsavel?.cpf) {
      // Mesma pessoa em várias linhas (irmãos): vale o nome da primeira; nome diferente vira aviso.
      const primeiro = responsaveisNoArquivo.get(responsavel.cpf);
      if (primeiro === undefined) responsaveisNoArquivo.set(responsavel.cpf, normalizarBusca(responsavel.nome));
      else if (primeiro !== normalizarBusca(responsavel.nome)) {
        divergencias.push({ linha: numero, campo: 'responsavelNome', codigo: 'responsavel_nome_divergente_no_arquivo', gravidade: 'aviso' });
      }
    }
    if (nascimento && ehMenorDeIdade(nascimento, hoje) && !responsavel) {
      divergencias.push({ linha: numero, campo: 'nascimento', codigo: 'menor_sem_responsavel', gravidade: 'aviso' });
    }
    validas.push({
      linha: numero,
      nome: nome.valor as string,
      telefone: telefone as string,
      ...(social.valor ? { nomeSocial: social.valor } : {}),
      ...(cpf ? { cpf } : {}),
      ...(nascimento ? { nascimento } : {}),
      ...(responsavel ? { responsavel } : {}),
    });
  }
  return { validas, divergencias, linhasComErro };
}

/** Valida as linhas de um lote de AGENDA (só formato; quem é o paciente/profissional/tipo, na simulação). */
export function validarAgenda(planilha: Planilha, mapa: Mapeamento): Validacao<AgendamentoDaLinha> {
  const divergencias: Divergencia[] = [];
  const validas: AgendamentoDaLinha[] = [];
  let linhasComErro = 0;
  for (const { numero, celulas } of planilha.linhas) {
    const erros: Divergencia[] = [];
    const erro = (campo: string, codigo: string) => erros.push({ linha: numero, campo, codigo, gravidade: 'erro' });
    if (celulas.length !== planilha.cabecalho.length) erro('linha', 'numero_de_colunas');
    const cpfBruto = celula(celulas, mapa, 'cpf').trim();
    const cpf = cpfBruto ? normalizarCpf(cpfBruto) : undefined;
    if (cpfBruto && !cpf) erro('cpf', pareceFormula(cpfBruto) ? 'formula_na_celula' : 'cpf_invalido');
    const paciente = texto(celula(celulas, mapa, 'paciente'), 200);
    if (paciente.codigo) erro('paciente', paciente.codigo);
    if (!cpf && !cpfBruto && !paciente.valor && !paciente.codigo) erro('paciente', 'obrigatorio');
    const dataBruta = celula(celulas, mapa, 'data').trim();
    const data = lerData(dataBruta);
    if (!data) erro('data', dataBruta ? 'data_invalida' : 'obrigatorio');
    const horaBruta = celula(celulas, mapa, 'hora').trim();
    const hora = lerHora(horaBruta);
    if (!hora) erro('hora', horaBruta ? 'hora_invalida' : 'obrigatorio');
    const profissional = texto(celula(celulas, mapa, 'profissional'), 200);
    if (profissional.codigo) erro('profissional', profissional.codigo);
    else if (!profissional.valor) erro('profissional', 'obrigatorio');
    const tipo = texto(celula(celulas, mapa, 'tipo'), 100);
    if (tipo.codigo) erro('tipo', tipo.codigo);
    else if (!tipo.valor) erro('tipo', 'obrigatorio');
    if (erros.length > 0) {
      linhasComErro++;
      divergencias.push(...erros);
      continue;
    }
    validas.push({
      linha: numero,
      data: data as string,
      hora: hora as string,
      profissional: profissional.valor as string,
      tipo: tipo.valor as string,
      ...(cpf ? { cpf } : {}),
      ...(paciente.valor ? { paciente: paciente.valor } : {}),
    });
  }
  return { validas, divergencias, linhasComErro };
}

/** Ação planejada para uma linha válida na simulação (dry-run). */
export interface AcaoPlanejada {
  readonly linha: number;
  readonly acao: 'criar' | 'ignorar';
  /** Para agenda: ids resolvidos (entram no hash: mudou o cadastro, muda o plano). */
  readonly ref?: string;
}

/**
 * Hash do plano: tipo + versão do termo + ação de cada linha (+ ids resolvidos). Não leva valor de campo.
 * Aplicar recalcula o plano e exige o MESMO hash da simulação que o admin viu (G8: nada sem aprovar).
 */
/**
 * R1 do parecer do importador: o hash amarra o plano ao MAPEAMENTO (canônico: campos em ordem) e à
 * VERSÃO DO ARQUIVO (SHA-256 do bruto). Trocar a coluna de `nome` com a de `nomeSocial` depois do
 * dry-run muda o hash, e o aplicar recusa.
 */
export function hashDoPlano(kind: ImportKind, acoes: readonly AcaoPlanejada[], mapa: Mapeamento, sha256Arquivo: string): string {
  const mapaCanonico = Object.keys(mapa)
    .sort()
    .map((campo) => [campo, mapa[campo]]);
  const canonico = JSON.stringify([kind, TERMO_MIGRACAO_VERSAO, mapaCanonico, sha256Arquivo, acoes.map((a) => [a.linha, a.acao, a.ref ?? null])]);
  return createHash('sha256').update(canonico, 'utf8').digest('hex');
}

/** Valor da célula para o relatório (neutralizado contra fórmula), ou null se o campo não está mapeado. */
export function valorParaRelatorio(planilha: Planilha, mapa: Mapeamento, linha: number, campo: string): string | null {
  const idx = mapa[campo];
  if (idx === undefined) return null;
  const registro = planilha.linhas.find((l) => l.numero === linha);
  const v = registro?.celulas[idx];
  return v === undefined ? null : neutralizarFormula(v);
}
