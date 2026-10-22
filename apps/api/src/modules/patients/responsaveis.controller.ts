import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProibidoError } from '../../common/erros-dominio';
import { exigirObjeto, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { temPermissao } from '../auth/perfis';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { noFusoDaClinica } from '../scheduling/agenda-regras';
import {
  ResponsaveisService,
  type EventoDoHistoricoDto,
  type ListaDeResponsaveis,
  type ResponsavelDto,
} from './responsaveis.service';
import {
  validarAlteracaoVinculo,
  validarAnulacao,
  validarEmancipacao,
  validarEncerramento,
  validarFiltroResponsaveis,
  validarNovoVinculo,
  validarPagador,
} from './responsaveis.validation';

/**
 * Responsáveis do paciente (PAC-01.2, migração 0028). Sem DELETE: encerrar a vigência. Nome, CPF e
 * telefone do responsável só no corpo (nunca em path ou query, V1 do parecer #57). `:vinculoId` é o id do
 * VÍNCULO responsável ↔ paciente.
 */
@Controller('pacientes/:id/responsaveis')
@UseGuards(SessaoGuard)
export class ResponsaveisController {
  constructor(@Inject(ResponsaveisService) private readonly service: ResponsaveisService) {}

  @Get()
  @Permissao('responsaveis:ler')
  listar(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<ListaDeResponsaveis> {
    const pacienteId = exigirUuid(id);
    return this.service.listar(paraRequestContext(auth), pacienteId, validarFiltroResponsaveis(query));
  }

  @Post()
  @Permissao('responsaveis:escrever')
  criar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ResponsavelDto> {
    const pacienteId = exigirUuid(id);
    const dados = validarNovoVinculo(corpo, noFusoDaClinica(new Date()).data);
    if (dados.recebeInformacaoClinica) exigirLiberacaoClinica(auth);
    return this.service.criar(paraRequestContext(auth), pacienteId, dados);
  }

  @Patch(':vinculoId')
  @Permissao('responsaveis:escrever')
  alterar(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('vinculoId') vinculoId: string,
    @Body() corpo: unknown,
  ): Promise<ResponsavelDto> {
    const pacienteId = exigirUuid(id);
    const vinculo = exigirUuid(vinculoId, 'vinculoId');
    const dados = validarAlteracaoVinculo(corpo);
    if (dados.recebeInformacaoClinica === true) exigirLiberacaoClinica(auth);
    return this.service.alterar(paraRequestContext(auth), pacienteId, vinculo, dados);
  }

  @Post(':vinculoId/pagador')
  @HttpCode(200)
  @Permissao('responsaveis:escrever')
  pagador(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('vinculoId') vinculoId: string,
    @Body() corpo: unknown,
  ): Promise<ResponsavelDto> {
    const pacienteId = exigirUuid(id);
    const vinculo = exigirUuid(vinculoId, 'vinculoId');
    const dados = validarPagador(corpo);
    return this.service.marcarPagador(paraRequestContext(auth), pacienteId, vinculo, dados.pagador, dados.cienciaDoPaciente);
  }

  @Post(':vinculoId/encerrar')
  @HttpCode(200)
  @Permissao('responsaveis:escrever')
  encerrar(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('vinculoId') vinculoId: string,
    @Body() corpo: unknown,
  ): Promise<ResponsavelDto> {
    const pacienteId = exigirUuid(id);
    const vinculo = exigirUuid(vinculoId, 'vinculoId');
    return this.service.encerrar(paraRequestContext(auth), pacienteId, vinculo, validarEncerramento(corpo, noFusoDaClinica(new Date()).data));
  }

  /** Anulação de cadastro errado (A4 do #67): motivo no corpo (cifrado), prazo de descarte. */
  @Post(':vinculoId/anular')
  @HttpCode(200)
  @Permissao('responsaveis:escrever')
  anular(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('vinculoId') vinculoId: string,
    @Body() corpo: unknown,
  ): Promise<ResponsavelDto> {
    const pacienteId = exigirUuid(id);
    const vinculo = exigirUuid(vinculoId, 'vinculoId');
    return this.service.anular(paraRequestContext(auth), pacienteId, vinculo, validarAnulacao(corpo).motivo);
  }

  /** Emancipação do paciente (A3 do #67): encerra a menoridade; documento só no corpo (cifrado). */
  @Post('emancipacao')
  @HttpCode(200)
  @Permissao('responsaveis:registrar_emancipacao')
  emancipacao(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ListaDeResponsaveis> {
    const pacienteId = exigirUuid(id);
    return this.service.registrarEmancipacao(paraRequestContext(auth), pacienteId, validarEmancipacao(corpo, noFusoDaClinica(new Date()).data));
  }

  /** A4 do #67: eliminação dos responsáveis com o prontuário, vencida a guarda de 20 anos (dono da clínica). */
  @Post('eliminacao')
  @HttpCode(200)
  @Permissao('cadastros:gerir')
  eliminacao(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const pacienteId = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.eliminarComOProntuario(paraRequestContext(auth), pacienteId);
  }

  @Get(':vinculoId/historico')
  @Permissao('responsaveis:ler')
  historico(@Sessao() auth: AuthContext, @Param('id') id: string, @Param('vinculoId') vinculoId: string): Promise<readonly EventoDoHistoricoDto[]> {
    const pacienteId = exigirUuid(id);
    return this.service.historico(paraRequestContext(auth), pacienteId, exigirUuid(vinculoId, 'vinculoId'));
  }
}

/** Descarte das pessoas de cadastros anulados com o prazo vencido (A4 do #67): dono da clínica. */
@Controller('responsaveis/descarte')
@UseGuards(SessaoGuard)
export class DescarteDeResponsaveisController {
  constructor(@Inject(ResponsaveisService) private readonly service: ResponsaveisService) {}

  @Post()
  @HttpCode(200)
  @Permissao('cadastros:gerir')
  executar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<{ readonly descartados: number }> {
    exigirObjeto(corpo ?? {}, []);
    return this.service.descartarAnulados(paraRequestContext(auth));
  }
}

/** Ligar a informação clínica para o responsável: só o profissional (A2 do #67), nunca a recepção nem o admin não clínico. */
function exigirLiberacaoClinica(auth: AuthContext): void {
  if (!temPermissao(auth.perfis, 'responsaveis:liberar_informacao_clinica')) {
    throw new ProibidoError('liberar_informacao_clinica_sem_permissao');
  }
}
