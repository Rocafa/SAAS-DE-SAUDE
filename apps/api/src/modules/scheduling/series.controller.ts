import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import type { AgendamentoDto } from './scheduling.service';
import { SeriesService, type CancelamentoDeSerieDto, type SerieDto } from './series.service';
import { validarCancelamentoDeSerie, validarFiltroSeries, validarNovaSerie } from './series.validation';

/**
 * Sessões recorrentes (HU-AGD-008; semântica de criarSerie/removerSerie da ApiClinica). Criar gera todos os
 * agendamentos de uma vez (tudo ou nada: 409 `serie_com_conflito` com as `datas` lotadas). Não há exclusão:
 * "remover a série" é cancelar a partir de uma data. Doc: docs/04-arquitetura/api-dominio.md §5c.
 */
@Controller('series')
@UseGuards(SessaoGuard)
export class SeriesController {
  constructor(@Inject(SeriesService) private readonly service: SeriesService) {}

  @Get()
  @Permissao('series:ler')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: SerieDto[]; truncado: boolean }> {
    return this.service.listar(paraRequestContext(auth), validarFiltroSeries(query));
  }

  @Post()
  @Permissao('series:escrever')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<{ serie: SerieDto; agendamentos: AgendamentoDto[] }> {
    return this.service.criar(paraRequestContext(auth), validarNovaSerie(corpo));
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @Permissao('series:escrever')
  cancelar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<CancelamentoDeSerieDto> {
    const alvo = exigirUuid(id);
    return this.service.cancelarAPartirDe(paraRequestContext(auth), alvo, validarCancelamentoDeSerie(corpo).aPartirDe);
  }
}
