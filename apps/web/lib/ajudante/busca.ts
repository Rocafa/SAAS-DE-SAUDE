/**
 * Busca universal do Ajudante: pacientes (nome, nome social, telefone, fim do CPF), agendamentos,
 * páginas, configurações, ações e artigos de ajuda. Tudo em memória, no navegador.
 */
import type { Agendamento, Paciente, Papel } from '../api/tipos';
import { nomeExibido } from '../api/tipos';
import { normalizar, notaTexto, somenteDigitos, tokens, notaPalavra } from '../texto';
import { acharAcao, type ParamsAcao } from './acoes';
import { ARTIGOS, PAGINAS, type Artigo } from './catalogo';
import { formatarDia, paraIsoLocal } from './datas';
import { interpretadorPadrao, type Intencao, type IntentParser } from './intencao';

export type Grupo = 'Fazer' | 'Pacientes' | 'Agenda' | 'Páginas' | 'Configurações' | 'Ajuda';

export const ORDEM_GRUPOS: Grupo[] = ['Fazer', 'Pacientes', 'Agenda', 'Páginas', 'Configurações', 'Ajuda'];

export interface Resultado {
  id: string;
  grupo: Grupo;
  titulo: string;
  detalhe?: string;
  /** Leva direto para esta rota (pacientes, agendamentos, páginas). */
  rota?: string;
  /** Ou executa uma ação do registro. */
  acaoId?: string;
  params?: ParamsAcao;
  requiresConfirm?: boolean;
  artigo?: Artigo;
  nota: number;
}

export interface GrupoResultados {
  grupo: Grupo;
  itens: Resultado[];
}

export interface IndiceBusca {
  pacientes: Paciente[];
  agendamentos: Agendamento[];
  agora: Date;
  papel: Papel;
}

const LIMITE_POR_GRUPO = 5;

/** Mostra só o fim do CPF: dado pessoal não aparece inteiro na busca. */
export function cpfMascarado(cpf: string): string {
  const d = somenteDigitos(cpf);
  return `***.***.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

export function acharPacientes(texto: string, pacientes: Paciente[]): { paciente: Paciente; nota: number }[] {
  const digitos = somenteDigitos(texto);
  const letras = texto.replace(/[\d().\-/]/g, ' ').trim();
  const achados: { paciente: Paciente; nota: number }[] = [];
  for (const p of pacientes) {
    let nota = 0;
    if (letras) {
      const social = p.nomeSocial ? notaTexto(letras, p.nomeSocial) : 0;
      // Empate: o nome social vence (é o nome que a pessoa usa).
      nota = Math.max(notaTexto(letras, p.nome), social > 0 ? social + 0.01 : 0);
    }
    if (digitos.length >= 3) {
      const tel = somenteDigitos(p.telefone);
      const cpf = somenteDigitos(p.cpf);
      const bateDigito = tel.endsWith(digitos) || tel.includes(digitos) || cpf.endsWith(digitos);
      if (!bateDigito) nota = 0;
      else if (!letras) nota = 3;
    } else if (!letras) {
      nota = 0;
    }
    if (nota > 0) achados.push({ paciente: p, nota });
  }
  achados.sort((a, b) => b.nota - a.nota || nomeExibido(a.paciente).localeCompare(nomeExibido(b.paciente)));
  // Com acerto bom, esconde os "parecidos" fracos (ex.: "joao" não traz "Joana").
  const melhor = achados[0]?.nota ?? 0;
  return achados.filter((a) => a.nota >= Math.min(melhor, Math.max(1, melhor / 2)));
}

/** Para perguntas de ajuda: basta metade das palavras importantes bater. */
function notaFlexivel(consulta: string, alvo: string): number {
  const vazias = new Set(['como', 'eu', 'faco', 'o', 'a', 'de', 'da', 'do', 'um', 'uma', 'que', 'para', 'pra', 'onde', 'fica', 'posso', 'se']);
  const q = tokens(consulta).filter((p) => !vazias.has(p));
  const t = tokens(alvo);
  if (!q.length) return 0;
  let soma = 0;
  let batidas = 0;
  for (const palavra of q) {
    const melhor = Math.max(0, ...t.map((a) => notaPalavra(palavra, a)));
    if (melhor > 0) batidas++;
    soma += melhor;
  }
  return batidas / q.length >= 0.5 ? soma / q.length : 0;
}

function proximoAgendamento(agendamentos: Agendamento[], pacienteId: string, agora: Date, soHoje = false): Agendamento | undefined {
  const hoje = paraIsoLocal(agora);
  return agendamentos
    .filter(
      (a) =>
        a.pacienteId === pacienteId &&
        (soHoje ? a.data === hoje : a.data >= hoje) &&
        (a.status === 'agendado' || a.status === 'confirmado'),
    )
    .sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora))[0];
}

function quando(data: string | undefined, hora: string | undefined, agora: Date): string {
  const partes: string[] = [];
  if (data) partes.push(formatarDia(data, agora));
  if (hora) partes.push(`às ${hora}`);
  return partes.join(' ');
}

const PRECISA_PACIENTE = new Set<Intencao['tipo']>([
  'remarcar_consulta',
  'cancelar_consulta',
  'abrir_prontuario',
  'abrir_ficha',
  'imprimir_recibo',
  'registrar_chegada',
  'emitir_documento',
]);

function acoesDaIntencao(intencao: Intencao, indice: IndiceBusca): Resultado[] {
  const { agora } = indice;
  if (intencao.tipo === 'ajuda') return [];
  if (intencao.tipo === 'ver_agenda') {
    const params: ParamsAcao = {};
    if (intencao.data) {
      params.data = intencao.data;
      params.dataTexto = formatarDia(intencao.data, agora);
    }
    return [
      {
        id: `acao-agenda-${intencao.data ?? 'hoje'}`,
        grupo: 'Fazer',
        titulo: `Abrir a agenda de ${intencao.data ? formatarDia(intencao.data, agora) : 'hoje'}`,
        acaoId: 'ver_agenda',
        params,
        nota: 10,
      },
    ];
  }
  if (intencao.tipo === 'listar') {
    const titulos = {
      falta_confirmar: 'Ver quem falta confirmar hoje',
      chegaram: 'Ver quem já chegou',
      faltas: 'Ver quem faltou hoje',
    };
    return [{ id: `acao-lista-${intencao.lista}`, grupo: 'Fazer', titulo: titulos[intencao.lista], acaoId: 'listar', params: { lista: intencao.lista }, nota: 10 }];
  }
  if (intencao.tipo === 'cadastrar_paciente') {
    return [{ id: 'acao-cadastrar', grupo: 'Fazer', titulo: 'Cadastrar paciente novo', acaoId: 'ir_para', params: { rota: '/pacientes/novo' }, nota: 9 }];
  }

  const candidatos = intencao.paciente ? acharPacientes(intencao.paciente, indice.pacientes) : [];
  const melhores = candidatos.filter((c) => c.nota >= (candidatos[0]?.nota ?? 0) - 0.5).slice(0, 3);

  if (intencao.tipo === 'marcar_consulta' && !melhores.length) {
    const params: ParamsAcao = { encaixe: intencao.encaixe };
    if (intencao.data) Object.assign(params, { data: intencao.data, dataTexto: formatarDia(intencao.data, agora) });
    if (intencao.hora) params.hora = intencao.hora;
    const q = quando(intencao.data, intencao.hora, agora);
    return [
      {
        id: 'acao-marcar',
        grupo: 'Fazer',
        titulo: `${intencao.encaixe ? 'Fazer encaixe' : 'Marcar consulta'}${q ? ` ${q}` : ''}`,
        detalhe: intencao.paciente ? `Não achei "${intencao.paciente}". Você escolhe o paciente na tela.` : 'Você escolhe o paciente na tela.',
        acaoId: 'marcar_consulta',
        params,
        requiresConfirm: true,
        nota: 9,
      },
    ];
  }
  if (!PRECISA_PACIENTE.has(intencao.tipo) && intencao.tipo !== 'marcar_consulta') return [];

  const out: Resultado[] = [];
  for (const { paciente, nota } of melhores) {
    const nome = nomeExibido(paciente);
    const base: ParamsAcao = { pacienteId: paciente.id, nomePaciente: nome };
    const r = (id: string, titulo: string, acaoId: string, params: ParamsAcao, detalhe?: string): Resultado => {
      const res: Resultado = {
        id: `${id}-${paciente.id}`,
        grupo: 'Fazer',
        titulo,
        acaoId,
        params,
        requiresConfirm: acharAcao(acaoId).requiresConfirm,
        nota: 10 + nota,
      };
      if (detalhe) res.detalhe = detalhe;
      return res;
    };
    switch (intencao.tipo) {
      case 'marcar_consulta': {
        const p: ParamsAcao = { ...base, encaixe: intencao.encaixe };
        if (intencao.data) Object.assign(p, { data: intencao.data, dataTexto: formatarDia(intencao.data, agora) });
        if (intencao.hora) p.hora = intencao.hora;
        const q = quando(intencao.data, intencao.hora, agora);
        out.push(r('acao-marcar', `${intencao.encaixe ? 'Encaixar' : 'Marcar consulta para'} ${nome}${q ? `, ${q}` : ''}`, 'marcar_consulta', p));
        break;
      }
      case 'remarcar_consulta': {
        const ag = proximoAgendamento(indice.agendamentos, paciente.id, agora);
        if (!ag) break;
        const p: ParamsAcao = { ...base, agendamentoId: ag.id };
        if (intencao.data) Object.assign(p, { data: intencao.data, dataTexto: formatarDia(intencao.data, agora) });
        if (intencao.hora) p.hora = intencao.hora;
        const q = quando(intencao.data, intencao.hora, agora);
        out.push(
          r('acao-remarcar', `Remarcar ${nome}${q ? ` para ${q}` : ''}`, 'remarcar_consulta', p, `Marcada para ${quando(ag.data, ag.hora, agora)}`),
        );
        break;
      }
      case 'cancelar_consulta': {
        const ag = proximoAgendamento(indice.agendamentos, paciente.id, agora);
        if (!ag) break;
        out.push(r('acao-cancelar', `Cancelar a consulta de ${nome}`, 'cancelar_consulta', { ...base, agendamentoId: ag.id }, quando(ag.data, ag.hora, agora)));
        break;
      }
      case 'registrar_chegada': {
        const ag = proximoAgendamento(indice.agendamentos, paciente.id, agora, true);
        if (!ag) break;
        out.push(r('acao-chegada', `Avisar que ${nome} chegou`, 'registrar_chegada', { ...base, agendamentoId: ag.id }, `Consulta de hoje às ${ag.hora}`));
        break;
      }
      case 'abrir_prontuario':
        out.push(r('acao-prontuario', `Abrir o prontuário de ${nome}`, 'abrir_prontuario', base));
        break;
      case 'abrir_ficha':
        out.push(r('acao-ficha', `Abrir a ficha de ${nome}`, 'abrir_ficha', base));
        break;
      case 'imprimir_recibo':
        out.push(r('acao-recibo', `Imprimir o recibo da última consulta de ${nome}`, 'imprimir_recibo', base));
        break;
      case 'emitir_documento':
        // Atestado é ato do profissional que atendeu: não oferecer a perfil não clínico.
        if (intencao.documento === 'atestado' && indice.papel !== 'profissional') break;
        out.push(
          r(
            'acao-doc',
            `${intencao.documento === 'atestado' ? 'Fazer atestado' : 'Fazer declaração de comparecimento'} para ${nome}`,
            'ir_para',
            { ...base, rota: `/documentos?tipo=${intencao.documento}&paciente=${paciente.id}` },
          ),
        );
        break;
    }
  }
  return out;
}

export function buscar(texto: string, indice: IndiceBusca, parser: IntentParser = interpretadorPadrao): GrupoResultados[] {
  const consulta = normalizar(texto);
  if (!consulta) return [];
  const { agora } = indice;
  const resultados: Resultado[] = [];

  const intencao = parser.interpretar(texto, { agora });
  if (intencao) {
    for (const r of acoesDaIntencao(intencao, indice)) {
      if (acharAcao(r.acaoId!).permissao.includes(indice.papel)) resultados.push(r);
    }
  }

  const textoPaciente = intencao && 'paciente' in intencao && intencao.paciente ? intencao.paciente : texto;
  const pacientes = acharPacientes(textoPaciente, indice.pacientes).slice(0, LIMITE_POR_GRUPO);
  for (const { paciente, nota } of pacientes) {
    const detalhe = [paciente.nomeSocial ? `Registro: ${paciente.nome}` : '', paciente.telefone, `CPF ${cpfMascarado(paciente.cpf)}`, paciente.ativo ? '' : 'Inativo']
      .filter(Boolean)
      .join(' · ');
    resultados.push({ id: `paciente-${paciente.id}`, grupo: 'Pacientes', titulo: nomeExibido(paciente), detalhe, rota: `/pacientes/${paciente.id}`, nota });
  }
  const hoje = paraIsoLocal(agora);
  for (const { paciente } of pacientes.slice(0, 3)) {
    const proximos = indice.agendamentos
      .filter((a) => a.pacienteId === paciente.id && a.data >= hoje && a.status !== 'cancelado')
      .slice(0, 2);
    for (const a of proximos) {
      resultados.push({
        id: `agendamento-${a.id}`,
        grupo: 'Agenda',
        titulo: `${nomeExibido(paciente)}: ${quando(a.data, a.hora, agora)}`,
        rota: `/agenda?dia=${a.data}`,
        nota: 1,
      });
    }
  }

  if (!intencao || intencao.tipo !== 'ajuda') {
    for (const p of PAGINAS) {
      const nota = Math.max(notaTexto(texto, p.titulo), ...p.sinonimos.map((s) => notaTexto(texto, s) * 0.9));
      if (nota > 0) resultados.push({ id: `pagina-${p.id}`, grupo: p.grupo, titulo: p.titulo, rota: p.rota, nota });
    }
  }

  for (const a of ARTIGOS) {
    const nota = Math.max(notaFlexivel(texto, a.titulo), ...a.perguntas.map((q) => notaFlexivel(texto, q)));
    if (nota > 0) resultados.push({ id: `artigo-${a.id}`, grupo: 'Ajuda', titulo: a.titulo, artigo: a, nota: intencao?.tipo === 'ajuda' ? nota + 5 : nota });
  }

  const grupos: GrupoResultados[] = [];
  for (const grupo of ORDEM_GRUPOS) {
    const itens = resultados
      .filter((r) => r.grupo === grupo)
      .sort((a, b) => b.nota - a.nota)
      .slice(0, LIMITE_POR_GRUPO);
    if (itens.length) grupos.push({ grupo, itens });
  }
  // Pergunta de ajuda: o artigo vem primeiro.
  if (intencao?.tipo === 'ajuda') grupos.sort((a, b) => (a.grupo === 'Ajuda' ? -1 : b.grupo === 'Ajuda' ? 1 : 0));
  return grupos;
}
