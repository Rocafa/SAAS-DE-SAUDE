import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { PatientsService, type PacienteDto, type PaginaDePacientes } from './patients.service';
import { validarAlteracaoPaciente, validarBuscaPacientes, validarFiltroPacientes, validarNovoPaciente } from './patients.validation';

/**
 * Pacientes (cadastro). Semântica de `listarPacientes`/`obterPaciente` da ApiClinica, mais buscar,
 * criar, atualizar e inativar. Nenhuma rota devolve conteúdo clínico.
 *
 * Regra (V1 do parecer PR #57): texto livre e documento NUNCA em path ou query (vão para logs do
 * ALB/WAF); só ids opacos, datas, enums e paginação. A busca por nome vai no corpo de `POST /pacientes/busca`.
 */
@Controller('pacientes')
@UseGuards(SessaoGuard)
export class PatientsController {
  constructor(@Inject(PatientsService) private readonly service: PatientsService) {}

  @Get()
  @Permissao('pacientes:ler')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<PaginaDePacientes> {
    return this.service.listar(paraRequestContext(auth), validarFiltroPacientes(query));
  }

  /** Busca por nome: idempotente e sem efeito colateral além da auditoria, por isso 200. */
  @Post('busca')
  @HttpCode(200)
  @Permissao('pacientes:ler')
  buscar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<PaginaDePacientes> {
    return this.service.listar(paraRequestContext(auth), validarBuscaPacientes(corpo));
  }

  @Get(':id')
  @Permissao('pacientes:ler')
  obter(@Sessao() auth: AuthContext, @Param('id') id: string): Promise<PacienteDto> {
    return this.service.obter(paraRequestContext(auth), exigirUuid(id));
  }

  @Post()
  @Permissao('pacientes:escrever')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<PacienteDto> {
    return this.service.criar(paraRequestContext(auth), validarNovoPaciente(corpo));
  }

  @Patch(':id')
  @Permissao('pacientes:escrever')
  atualizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<PacienteDto> {
    const alvo = exigirUuid(id);
    return this.service.atualizar(paraRequestContext(auth), alvo, validarAlteracaoPaciente(corpo));
  }

  @Post(':id/inativar')
  @HttpCode(200)
  @Permissao('pacientes:inativar')
  inativar(@Sessao() auth: AuthContext, @Param('id') id: string): Promise<{ id: string; ativo: false }> {
    return this.service.inativar(paraRequestContext(auth), exigirUuid(id));
  }
}
