import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { exigirObjeto, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import type { JanelaDaGrade } from './disponibilidade-regras';
import { DisponibilidadeService, type BloqueioDto, type FeriadoDto } from './disponibilidade.service';
import {
  validarAno,
  validarFiltroBloqueios,
  validarFiltroGrade,
  validarGrade,
  validarNovoBloqueio,
  validarNovoFeriado,
} from './disponibilidade.validation';

/**
 * Disponibilidade da agenda (0100, HU-AGD-001/003): grade semanal, bloqueios e feriados. Configurar: dono e recepção
 * (`agenda:configurar`); ler: quem lê a agenda. Nada se apaga: remover = marcar removido (auditado).
 */
@Controller('agenda')
@UseGuards(SessaoGuard)
export class DisponibilidadeController {
  constructor(@Inject(DisponibilidadeService) private readonly service: DisponibilidadeService) {}

  @Get('grade')
  @Permissao('agenda:ler')
  lerGrade(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<JanelaDaGrade[]> {
    return this.service.lerGrade(paraRequestContext(auth), validarFiltroGrade(query));
  }

  @Put('grade/:profissionalId')
  @Permissao('agenda:configurar')
  definirGrade(@Sessao() auth: AuthContext, @Param('profissionalId') id: string, @Body() corpo: unknown): Promise<JanelaDaGrade[]> {
    const alvo = exigirUuid(id, 'profissionalId');
    return this.service.definirGrade(paraRequestContext(auth), alvo, validarGrade(corpo));
  }

  @Get('bloqueios')
  @Permissao('agenda:ler')
  listarBloqueios(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<BloqueioDto[]> {
    return this.service.listarBloqueios(paraRequestContext(auth), validarFiltroBloqueios(query));
  }

  @Post('bloqueios')
  @Permissao('agenda:configurar')
  criarBloqueio(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<BloqueioDto> {
    return this.service.criarBloqueio(paraRequestContext(auth), validarNovoBloqueio(corpo));
  }

  @Post('bloqueios/:id/remover')
  @HttpCode(204)
  @Permissao('agenda:configurar')
  removerBloqueio(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<void> {
    const alvo = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.removerBloqueio(paraRequestContext(auth), alvo);
  }

  @Get('feriados')
  @Permissao('agenda:ler')
  listarFeriados(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<FeriadoDto[]> {
    return this.service.listarFeriados(paraRequestContext(auth), validarAno(query));
  }

  @Post('feriados')
  @Permissao('agenda:configurar')
  criarFeriado(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<FeriadoDto> {
    return this.service.criarFeriado(paraRequestContext(auth), validarNovoFeriado(corpo));
  }

  @Post('feriados/nacionais')
  @HttpCode(200)
  @Permissao('agenda:configurar')
  carregarNacionais(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<FeriadoDto[]> {
    return this.service.carregarFeriadosNacionais(paraRequestContext(auth), validarAno(corpo));
  }

  @Post('feriados/:id/remover')
  @HttpCode(204)
  @Permissao('agenda:configurar')
  removerFeriado(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<void> {
    const alvo = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.removerFeriado(paraRequestContext(auth), alvo);
  }
}
