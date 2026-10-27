import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { exigirObjeto, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import type { StatusFront } from './agenda-regras';
import {
  SchedulingService,
  type AgendamentoDto,
  type ProfissionalDto,
  type TipoAtendimentoDto,
} from './scheduling.service';
import {
  validarFiltroAgenda,
  validarNovoAgendamento,
  validarNovoProfissional,
  validarNovoTipo,
  validarRemarcacao,
  validarStatus,
} from './scheduling.validation';

/**
 * Agenda (semântica de listarAgendamentos/criarAgendamento/remarcarAgendamento/alterarStatus da
 * ApiClinica). Encaixe = `encaixe: true` na criação. Não há exclusão: "remover" vira cancelar.
 */
@Controller('agendamentos')
@UseGuards(SessaoGuard)
export class AgendaController {
  constructor(@Inject(SchedulingService) private readonly service: SchedulingService) {}

  @Get()
  @Permissao('agenda:ler')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: AgendamentoDto[]; truncado: boolean }> {
    return this.service.listar(paraRequestContext(auth), validarFiltroAgenda(query));
  }

  @Post()
  @Permissao('agenda:escrever')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<AgendamentoDto> {
    return this.service.criar(paraRequestContext(auth), validarNovoAgendamento(corpo));
  }

  @Post(':id/remarcar')
  @HttpCode(200)
  @Permissao('agenda:escrever')
  remarcar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ data: string; hora: string }> {
    const alvo = exigirUuid(id);
    return this.service.remarcar(paraRequestContext(auth), alvo, validarRemarcacao(corpo));
  }

  @Post(':id/status')
  @HttpCode(200)
  @Permissao('agenda:escrever')
  status(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ statusAnterior: StatusFront }> {
    const alvo = exigirUuid(id);
    return this.service.alterarStatus(paraRequestContext(auth), auth.perfis, alvo, validarStatus(corpo));
  }

  @Post(':id/check-in')
  @HttpCode(200)
  @Permissao('agenda:escrever')
  checkIn(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ statusAnterior: StatusFront }> {
    const alvo = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.alterarStatus(paraRequestContext(auth), auth.perfis, alvo, 'chegou');
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @Permissao('agenda:escrever')
  cancelar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ statusAnterior: StatusFront }> {
    const alvo = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.alterarStatus(paraRequestContext(auth), auth.perfis, alvo, 'cancelado');
  }
}

/** Cadastros da agenda: profissionais e tipos de atendimento (gestão só do admin). */
@Controller()
@UseGuards(SessaoGuard)
export class CadastrosAgendaController {
  constructor(@Inject(SchedulingService) private readonly service: SchedulingService) {}

  @Get('profissionais')
  @Permissao('cadastros:ler')
  listarProfissionais(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<ProfissionalDto[]> {
    exigirObjeto(query ?? {}, []);
    return this.service.listarProfissionais(paraRequestContext(auth));
  }

  @Post('profissionais')
  @Permissao('cadastros:gerir')
  criarProfissional(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ProfissionalDto> {
    return this.service.criarProfissional(paraRequestContext(auth), validarNovoProfissional(corpo));
  }

  @Get('tipos-atendimento')
  @Permissao('cadastros:ler')
  listarTipos(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<TipoAtendimentoDto[]> {
    exigirObjeto(query ?? {}, []);
    return this.service.listarTipos(paraRequestContext(auth));
  }

  @Post('tipos-atendimento')
  @Permissao('cadastros:gerir')
  criarTipo(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<TipoAtendimentoDto> {
    return this.service.criarTipo(paraRequestContext(auth), validarNovoTipo(corpo));
  }
}
