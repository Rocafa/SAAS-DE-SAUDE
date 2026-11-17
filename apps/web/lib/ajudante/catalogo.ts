/**
 * Páginas, configurações e artigos de ajuda que o Ajudante encontra. A página Ajuda usa os mesmos
 * artigos, para o "Como faço…" ser igual nos dois lugares.
 */

export interface ItemPagina {
  id: string;
  titulo: string;
  rota: string;
  grupo: 'Páginas' | 'Configurações';
  sinonimos: string[];
}

export const PAGINAS: ItemPagina[] = [
  { id: 'inicio', titulo: 'Hoje', rota: '/inicio', grupo: 'Páginas', sinonimos: ['inicio', 'comeco', 'painel', 'resumo do dia'] },
  { id: 'agenda', titulo: 'Agenda', rota: '/agenda', grupo: 'Páginas', sinonimos: ['horarios', 'calendario', 'consultas'] },
  { id: 'marcar', titulo: 'Marcar consulta', rota: '/agenda/marcar', grupo: 'Páginas', sinonimos: ['agendar', 'nova consulta', 'novo horario'] },
  { id: 'espera', titulo: 'Lista de espera', rota: '/agenda?ver=espera', grupo: 'Páginas', sinonimos: ['espera', 'fila', 'encaixe'] },
  { id: 'pacientes', titulo: 'Pacientes', rota: '/pacientes', grupo: 'Páginas', sinonimos: ['clientes', 'cadastros', 'fichas', 'pessoas'] },
  { id: 'atendimento', titulo: 'Atendimento e prontuário', rota: '/atendimento', grupo: 'Páginas', sinonimos: ['prontuario', 'evolucao', 'sessao', 'assinar'] },
  { id: 'documentos', titulo: 'Documentos', rota: '/documentos', grupo: 'Páginas', sinonimos: ['atestado', 'declaracao', 'comparecimento'] },
  { id: 'financeiro', titulo: 'Financeiro', rota: '/financeiro', grupo: 'Páginas', sinonimos: ['dinheiro', 'pagamentos', 'caixa', 'receber', 'pix'] },
  { id: 'recibos', titulo: 'Recibos', rota: '/financeiro/recibos', grupo: 'Páginas', sinonimos: ['recibo', 'comprovante', 'nota'] },
  { id: 'pacotes', titulo: 'Pacotes de sessões', rota: '/financeiro?ver=pacotes', grupo: 'Páginas', sinonimos: ['pacote', 'saldo', 'sessoes'] },
  { id: 'guias', titulo: 'Guias de convênio', rota: '/guias', grupo: 'Páginas', sinonimos: ['convenio', 'plano de saude', 'guia', 'autorizacao'] },
  { id: 'mensagens', titulo: 'Mensagens', rota: '/mensagens', grupo: 'Páginas', sinonimos: ['whatsapp', 'zap', 'conversas', 'inbox'] },
  { id: 'relatorios', titulo: 'Relatórios', rota: '/relatorios', grupo: 'Páginas', sinonimos: ['numeros', 'graficos', 'faltas', 'recebido'] },
  { id: 'ajuda', titulo: 'Ajuda', rota: '/ajuda', grupo: 'Páginas', sinonimos: ['como faco', 'duvida', 'suporte', 'manual'] },
  { id: 'mais', titulo: 'Mais opções', rota: '/mais', grupo: 'Páginas', sinonimos: ['menu', 'outros'] },
  { id: 'configuracoes', titulo: 'Configurações', rota: '/configuracoes', grupo: 'Configurações', sinonimos: ['ajustes', 'opcoes', 'preferencias'] },
  { id: 'primeiros-passos', titulo: 'Primeiros passos', rota: '/primeiros-passos', grupo: 'Páginas', sinonimos: ['comecar', 'configurar clinica', 'importar', 'migrar', 'sistema antigo'] },
  { id: 'cfg-clinica', titulo: 'Dados da clínica', rota: '/configuracoes/clinica', grupo: 'Configurações', sinonimos: ['endereco', 'cnpj', 'logo', 'clinica'] },
  { id: 'cfg-usuarios', titulo: 'Usuários e permissões', rota: '/configuracoes/usuarios', grupo: 'Configurações', sinonimos: ['equipe', 'senha', 'acesso', 'convidar', 'recepcionista'] },
  { id: 'cfg-horarios', titulo: 'Horários de atendimento', rota: '/configuracoes/horarios', grupo: 'Configurações', sinonimos: ['expediente', 'grade', 'folga', 'feriado'] },
  { id: 'cfg-tipos', titulo: 'Tipos de atendimento', rota: '/configuracoes/tipos', grupo: 'Configurações', sinonimos: ['servicos', 'precos', 'valores', 'duracao'] },
  { id: 'cfg-modelos', titulo: 'Modelos de prontuário', rota: '/configuracoes/modelos', grupo: 'Configurações', sinonimos: ['modelo', 'formulario', 'anamnese'] },
  { id: 'cfg-privacidade', titulo: 'Privacidade e LGPD', rota: '/configuracoes/privacidade', grupo: 'Configurações', sinonimos: ['lgpd', 'baixar dados', 'exportar', 'quem acessou', 'auditoria'] },
  { id: 'cfg-plano', titulo: 'Plano e assinatura', rota: '/configuracoes/plano', grupo: 'Configurações', sinonimos: ['assinatura', 'pagar sistema', 'cancelar plano', 'mensalidade'] },
];

export interface Artigo {
  id: string;
  titulo: string;
  /** Jeitos de perguntar, para a busca achar o artigo. */
  perguntas: string[];
  passos: string[];
}

export const ARTIGOS: Artigo[] = [
  {
    id: 'como-marcar',
    titulo: 'Como marcar uma consulta',
    perguntas: ['como marco consulta', 'como agendar', 'marcar horario', 'nova consulta'],
    passos: [
      'Na tela Hoje, aperte o botão grande "Marcar consulta".',
      'Digite o nome do paciente e escolha na lista.',
      'Escolha o dia e o horário.',
      'Confira e aperte "Confirmar consulta".',
    ],
  },
  {
    id: 'como-cancelar',
    titulo: 'Como cancelar uma consulta',
    perguntas: ['como cancelo uma consulta', 'desmarcar', 'paciente nao vem', 'cancelar horario'],
    passos: [
      'Abra a ficha do paciente (digite o nome no Ajudante).',
      'Em "Próximas consultas", aperte "Cancelar" na consulta certa.',
      'Leia a pergunta e aperte "Sim, cancelar".',
      'Errou? Aperte "Desfazer" no aviso que aparece embaixo.',
    ],
  },
  {
    id: 'como-remarcar',
    titulo: 'Como remarcar uma consulta',
    perguntas: ['como remarco', 'mudar horario', 'trocar dia', 'adiar consulta'],
    passos: [
      'Abra a ficha do paciente.',
      'Em "Próximas consultas", aperte "Remarcar".',
      'Escolha o novo dia e o novo horário.',
      'Aperte "Confirmar nova data".',
    ],
  },
  {
    id: 'como-chegada',
    titulo: 'Como avisar que o paciente chegou',
    perguntas: ['paciente chegou', 'check in', 'registrar chegada', 'sala de espera'],
    passos: ['Na tela Hoje, ache o nome do paciente na lista.', 'Aperte "Chegou".', 'O nome passa para "Quem já chegou".'],
  },
  {
    id: 'como-recibo',
    titulo: 'Como imprimir um recibo',
    perguntas: ['como imprimo recibo', 'segunda via', 'comprovante de pagamento'],
    passos: ['Abra a ficha do paciente.', 'Desça até "Recibos".', 'Aperte "Imprimir" no recibo da data certa.'],
  },
  {
    id: 'como-exportar',
    titulo: 'Como baixar todos os dados da clínica',
    perguntas: ['exportar dados', 'levar meus dados', 'baixar tudo', 'trocar de sistema'],
    passos: [
      'Abra Configurações e depois "Privacidade e LGPD".',
      'Aperte "Baixar todos os dados da clínica".',
      'Confirme com o código de segurança. O link chega por e-mail e vale 24 horas.',
    ],
  },
  {
    id: 'como-cancelar-plano',
    titulo: 'Como cancelar a assinatura',
    perguntas: ['cancelar sistema', 'cancelar plano', 'parar de pagar', 'sair do sistema'],
    passos: [
      'Abra Configurações e depois "Plano e assinatura".',
      'Aperte "Cancelar assinatura" e confirme.',
      'Seus dados ficam disponíveis para leitura e para baixar por 90 dias. Sem multa e sem ligação.',
    ],
  },
  {
    id: 'como-ajudante',
    titulo: 'Como usar o Ajudante',
    perguntas: ['o que e o ajudante', 'atalho', 'buscar', 'procurar'],
    passos: [
      'Aperte o botão "Ajudante" no canto de baixo, ou a tecla /.',
      'Escreva do seu jeito: "agenda de amanhã", "marcar consulta para João quinta às 14h".',
      'Escolha "Fazer por mim" ou "Me mostra como".',
      'O Ajudante nunca grava nada sozinho: ele para no botão de confirmar.',
    ],
  },
];

/**
 * Alvos que o Ajudante sabe destacar (atributo `data-assist-id` nas telas). Um teste garante que
 * toda ação só aponta para alvos desta lista.
 */
export const ALVOS = [
  'menu-inicio',
  'menu-agenda',
  'menu-pacientes',
  'menu-atendimento',
  'menu-financeiro',
  'menu-mais',
  'inicio-marcar',
  'inicio-falta-confirmar',
  'inicio-chegaram',
  'inicio-faltas',
  'marcar-paciente',
  'marcar-dia',
  'marcar-hora',
  'marcar-confirmar',
  'ficha-proximas',
  'ficha-cancelar',
  'ficha-prontuario',
  'ficha-recibos',
  'ficha-imprimir-recibo',
  'chegada',
  'agenda-dia',
] as const;

export type Alvo = (typeof ALVOS)[number];
