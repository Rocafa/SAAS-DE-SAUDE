import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { exigirObjeto, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { UnidadesService, type SalaDto, type UnidadeDto } from './unidades.service';
import {
  validarAlteracaoSala,
  validarAlteracaoUnidade,
  validarFiltroSalas,
  validarNovaSala,
  validarNovaUnidade,
} from './unidades.validation';

/**
 * Unidades e salas (HU-NUC-002). Gestão só do admin (`cadastros:gerir`); a leitura é da equipe (`cadastros:ler`),
 * porque quem agenda escolhe a sala. Não há exclusão: `ativa: false` inativa.
 */
@Controller()
@UseGuards(SessaoGuard)
export class UnidadesController {
  constructor(@Inject(UnidadesService) private readonly service: UnidadesService) {}

  @Get('unidades')
  @Permissao('cadastros:ler')
  listarUnidades(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<UnidadeDto[]> {
    exigirObjeto(query ?? {}, []);
    return this.service.listarUnidades(paraRequestContext(auth));
  }

  @Post('unidades')
  @Permissao('cadastros:gerir')
  criarUnidade(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<UnidadeDto> {
    return this.service.criarUnidade(paraRequestContext(auth), validarNovaUnidade(corpo));
  }

  @Patch('unidades/:id')
  @Permissao('cadastros:gerir')
  alterarUnidade(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<UnidadeDto> {
    const alvo = exigirUuid(id);
    return this.service.alterarUnidade(paraRequestContext(auth), alvo, validarAlteracaoUnidade(corpo));
  }

  @Get('salas')
  @Permissao('cadastros:ler')
  listarSalas(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<SalaDto[]> {
    return this.service.listarSalas(paraRequestContext(auth), validarFiltroSalas(query));
  }

  @Post('salas')
  @Permissao('cadastros:gerir')
  criarSala(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<SalaDto> {
    return this.service.criarSala(paraRequestContext(auth), validarNovaSala(corpo));
  }

  @Patch('salas/:id')
  @Permissao('cadastros:gerir')
  alterarSala(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<SalaDto> {
    const alvo = exigirUuid(id);
    return this.service.alterarSala(paraRequestContext(auth), alvo, validarAlteracaoSala(corpo));
  }
}
