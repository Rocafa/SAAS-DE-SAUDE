/**
 * Registro de ações do Ajudante. Cada ação vira um ROTEIRO de passos que o executor faz na tela
 * ("Fazer por mim") ou mostra ao usuário ("Me mostra como"). Toda ação que grava algo termina num
 * passo `confirmar`: o Ajudante para no botão e quem aperta é a pessoa. Nunca grava sozinho.
 */
import type { Papel } from '../api/tipos';
import type { Alvo } from './catalogo';

export type Passo =
  | { tipo: 'navegar'; rota: string; narracao: string; alvo?: Alvo }
  | { tipo: 'destacar'; alvo: Alvo; narracao: string; chave?: string }
  | { tipo: 'preencher'; alvo: Alvo; valor: string; rotuloValor: string; narracao: string }
  | { tipo: 'confirmar'; alvo: Alvo; narracao: string; chave?: string };

export interface ParamsAcao {
  pacienteId?: string;
  nomePaciente?: string;
  data?: string;
  /** "quinta, 15/10", só para a narração. */
  dataTexto?: string;
  hora?: string;
  agendamentoId?: string;
  encaixe?: boolean;
  rota?: string;
  lista?: 'falta_confirmar' | 'chegaram' | 'faltas';
}

export interface AcaoAjudante {
  id: string;
  rotulo: string;
  sinonimos: string[];
  permissao: Papel[];
  /** true quando a ação grava algo: o roteiro PRECISA terminar em `confirmar`. */
  requiresConfirm: boolean;
  handler: (p: ParamsAcao) => Passo[];
}

const TODOS: Papel[] = ['admin', 'profissional', 'recepcao'];

function passosMarcar(p: ParamsAcao, rota: string): Passo[] {
  const passos: Passo[] = [
    { tipo: 'navegar', rota, alvo: 'menu-agenda', narracao: 'Abrindo Marcar consulta…' },
  ];
  if (p.pacienteId && p.nomePaciente && !p.agendamentoId) {
    passos.push({ tipo: 'preencher', alvo: 'marcar-paciente', valor: p.pacienteId, rotuloValor: p.nomePaciente, narracao: `Paciente: ${p.nomePaciente}` });
  }
  if (p.data) {
    passos.push({ tipo: 'preencher', alvo: 'marcar-dia', valor: p.data, rotuloValor: p.dataTexto ?? p.data, narracao: `Dia: ${p.dataTexto ?? p.data}` });
  } else {
    passos.push({ tipo: 'destacar', alvo: 'marcar-dia', narracao: 'Escolha o dia aqui.' });
  }
  if (p.hora) {
    passos.push({ tipo: 'preencher', alvo: 'marcar-hora', valor: p.hora, rotuloValor: p.hora, narracao: `Horário: ${p.hora}` });
  } else {
    passos.push({ tipo: 'destacar', alvo: 'marcar-hora', narracao: 'Escolha o horário aqui.' });
  }
  passos.push({ tipo: 'confirmar', alvo: 'marcar-confirmar', narracao: 'Confira e aperte o botão para confirmar.' });
  return passos;
}

function ficha(p: ParamsAcao): Passo {
  return {
    tipo: 'navegar',
    rota: `/pacientes/${p.pacienteId ?? ''}`,
    alvo: 'menu-pacientes',
    narracao: `Abrindo Pacientes… ${p.nomePaciente ?? ''}`.trim(),
  };
}

export const ACOES: AcaoAjudante[] = [
  {
    id: 'marcar_consulta',
    rotulo: 'Marcar consulta',
    sinonimos: ['agendar', 'marcar horario', 'nova consulta', 'encaixe'],
    permissao: TODOS,
    requiresConfirm: true,
    handler: (p) => {
      const q = new URLSearchParams();
      if (p.encaixe) q.set('encaixe', '1');
      return passosMarcar(p, `/agenda/marcar${q.size ? `?${q}` : ''}`);
    },
  },
  {
    id: 'remarcar_consulta',
    rotulo: 'Remarcar consulta',
    sinonimos: ['mudar horario', 'trocar dia', 'adiar'],
    permissao: TODOS,
    requiresConfirm: true,
    handler: (p) => passosMarcar(p, `/agenda/marcar?remarcar=${p.agendamentoId ?? ''}`),
  },
  {
    id: 'cancelar_consulta',
    rotulo: 'Cancelar consulta',
    sinonimos: ['desmarcar'],
    permissao: TODOS,
    requiresConfirm: true,
    handler: (p) => [
      ficha(p),
      { tipo: 'destacar', alvo: 'ficha-proximas', narracao: 'Próximas consultas' },
      { tipo: 'confirmar', alvo: 'ficha-cancelar', chave: p.agendamentoId ?? '', narracao: 'Aperte "Cancelar" para confirmar.' },
    ],
  },
  {
    id: 'abrir_ficha',
    rotulo: 'Abrir ficha do paciente',
    sinonimos: ['cadastro', 'dados', 'telefone'],
    permissao: TODOS,
    requiresConfirm: false,
    handler: (p) => [ficha(p)],
  },
  {
    id: 'abrir_prontuario',
    rotulo: 'Abrir prontuário',
    sinonimos: ['evolucao', 'historico'],
    // Só perfil clínico (o administrador que também atende entra como 'profissional').
    permissao: ['profissional'],
    requiresConfirm: false,
    handler: (p) => [ficha(p), { tipo: 'destacar', alvo: 'ficha-prontuario', narracao: 'Prontuário' }],
  },
  {
    id: 'imprimir_recibo',
    rotulo: 'Imprimir recibo',
    sinonimos: ['comprovante', 'segunda via'],
    permissao: TODOS,
    requiresConfirm: true,
    handler: (p) => [
      ficha(p),
      { tipo: 'destacar', alvo: 'ficha-recibos', narracao: 'Recibos' },
      { tipo: 'confirmar', alvo: 'ficha-imprimir-recibo', narracao: 'Aperte "Imprimir" no recibo mais recente.' },
    ],
  },
  {
    id: 'registrar_chegada',
    rotulo: 'Avisar que o paciente chegou',
    sinonimos: ['check in', 'chegada'],
    permissao: TODOS,
    requiresConfirm: true,
    handler: (p) => [
      { tipo: 'navegar', rota: '/inicio', alvo: 'menu-inicio', narracao: 'Abrindo Hoje…' },
      { tipo: 'confirmar', alvo: 'chegada', chave: p.agendamentoId ?? '', narracao: `Aperte "Chegou" ao lado de ${p.nomePaciente ?? 'paciente'}.` },
    ],
  },
  {
    id: 'ver_agenda',
    rotulo: 'Abrir agenda',
    sinonimos: ['horarios', 'calendario'],
    permissao: TODOS,
    requiresConfirm: false,
    handler: (p) => [
      {
        tipo: 'navegar',
        rota: p.data ? `/agenda?dia=${p.data}` : '/agenda',
        alvo: 'menu-agenda',
        narracao: `Abrindo a agenda${p.dataTexto ? ` de ${p.dataTexto}` : ''}…`,
      },
    ],
  },
  {
    id: 'listar',
    rotulo: 'Mostrar lista',
    sinonimos: ['falta confirmar', 'quem chegou', 'faltas'],
    permissao: TODOS,
    requiresConfirm: false,
    handler: (p) => {
      const alvo: Alvo =
        p.lista === 'chegaram' ? 'inicio-chegaram' : p.lista === 'faltas' ? 'inicio-faltas' : 'inicio-falta-confirmar';
      return [
        { tipo: 'navegar', rota: '/inicio', alvo: 'menu-inicio', narracao: 'Abrindo Hoje…' },
        { tipo: 'destacar', alvo, narracao: 'Aqui está a lista.' },
      ];
    },
  },
  {
    id: 'ir_para',
    rotulo: 'Ir para a página',
    sinonimos: [],
    permissao: TODOS,
    requiresConfirm: false,
    handler: (p) => [{ tipo: 'navegar', rota: p.rota ?? '/inicio', narracao: 'Abrindo…' }],
  },
];

export function acharAcao(id: string): AcaoAjudante {
  const a = ACOES.find((x) => x.id === id);
  if (!a) throw new Error(`Ação desconhecida: ${id}`);
  return a;
}

export function acoesPermitidas(papel: Papel): AcaoAjudante[] {
  return ACOES.filter((a) => a.permissao.includes(papel));
}
