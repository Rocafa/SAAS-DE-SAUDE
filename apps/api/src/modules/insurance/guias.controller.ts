import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { VigilanciaDeLeituraService } from '../patients/vigilancia-de-leitura';
import { LIMIARES_GUIA } from './guias-regras';
import {
  GuiasService,
  type AlertaDeGuiaDto,
  type ConsumoGuiaDto,
  type ConvenioDto,
  type GuiaDetalheDto,
  type PaginaDeGuias,
  type RelatorioConvenioDto,
  type ResultadoConsumoDto,
} from './guias.service';
import {
  validarAlteracaoConvenio,
  validarAlteracaoGuia,
  validarAssinatura,
  validarConsumoGuia,
  validarConsumoPacote,
  validarCorpoVazio,
  validarEstornoGuia,
  validarEstornoPacote,
  validarFiltroGuias,
  validarFiltroPacotes,
  validarFiltroRelatorio,
  validarLimiares,
  validarNovaGuia,
  validarNovoConvenio,
  validarNovoPacote,
  validarQueryVazia,
  validarTrocaProfissionalPacote,
} from './guias.validation';
import { PacotesService, type ConsumoPacoteDto, type PacoteDto, type ResultadoConsumoPacoteDto } from './pacotes.service';

/**
 * Convênios (CNV-04.1) e relatório por convênio (CNV-04.6). Na URL só ids e datas: nome do convênio,
 * número de guia, senha e carteirinha vão no corpo.
 */
@Controller('convenios')
@UseGuards(SessaoGuard)
export class ConveniosController {
  constructor(
    @Inject(GuiasService) private readonly service: GuiasService,
    @Inject(VigilanciaDeLeituraService) private readonly vigilancia: VigilanciaDeLeituraService,
  ) {}

  @Get()
  @Permissao('convenios:ler')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<ConvenioDto[]> {
    validarQueryVazia(query);
    return this.service.listarConvenios(paraRequestContext(auth));
  }

  @Post()
  @Permissao('convenios:gerir')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ConvenioDto> {
    return this.service.criarConvenio(paraRequestContext(auth), validarNovoConvenio(corpo));
  }

  @Patch(':id')
  @Permissao('convenios:gerir')
  atualizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ConvenioDto> {
    const alvo = exigirUuid(id);
    return this.service.atualizarConvenio(paraRequestContext(auth), alvo, validarAlteracaoConvenio(corpo));
  }

  @Post(':id/inativar')
  @HttpCode(200)
  @Permissao('convenios:gerir')
  inativar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ConvenioDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return this.service.inativarConvenio(paraRequestContext(auth), alvo);
  }

  /** Faturamento: `?de=AAAA-MM-DD&ate=AAAA-MM-DD`, janela de até 31 dias. */
  @Get(':id/relatorio')
  @Permissao('guias:faturar')
  async relatorio(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<RelatorioConvenioDto> {
    const alvo = exigirUuid(id);
    const filtro = validarFiltroRelatorio(query);
    const ctx = paraRequestContext(auth);
    // Lista pacientes com nº de guia decifrado: conta no limite por usuário (R5).
    await this.vigilancia.listagem(ctx);
    return this.service.relatorio(ctx, alvo, filtro);
  }
}

/**
 * Guias de convênio (CNV-04.2 a 04.5; `listarGuias`/`criarGuia`/`removerGuia` da ApiClinica).
 * `removerGuia` = cancelar (não há exclusão). Recepção e financeiro operam; nenhuma rota devolve
 * conteúdo clínico.
 */
@Controller('guias')
@UseGuards(SessaoGuard)
export class GuiasController {
  constructor(
    @Inject(GuiasService) private readonly service: GuiasService,
    @Inject(VigilanciaDeLeituraService) private readonly vigilancia: VigilanciaDeLeituraService,
  ) {}

  /** Lista e alertas contam no limite por usuário das listas de pacientes (R5); 429 acima dele. */
  @Get()
  @Permissao('guias:ler')
  async listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<PaginaDeGuias> {
    const filtro = validarFiltroGuias(query);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.service.listarGuias(ctx, filtro);
  }

  /** Antes de `:id`: `?diasVencimento=7&sessoesRestantes=1` (padrões). */
  @Get('alertas')
  @Permissao('guias:ler')
  async alertas(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: AlertaDeGuiaDto[]; truncado: boolean }> {
    const limiares = validarLimiares(query, LIMIARES_GUIA);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.service.alertas(ctx, limiares);
  }

  @Post()
  @Permissao('guias:gerir')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<GuiaDetalheDto> {
    return this.service.criarGuia(paraRequestContext(auth), validarNovaGuia(corpo));
  }

  @Get(':id')
  @Permissao('guias:ler')
  async obter(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<GuiaDetalheDto> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    const ctx = paraRequestContext(auth);
    // Detalhe traz senha e carteirinha: conta como ficha distinta aberta (alerta de anomalia, R5).
    await this.vigilancia.ficha(ctx, `guia:${alvo}`);
    return this.service.obterGuia(ctx, alvo);
  }

  @Patch(':id')
  @Permissao('guias:gerir')
  atualizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<GuiaDetalheDto> {
    const alvo = exigirUuid(id);
    return this.service.atualizarGuia(paraRequestContext(auth), alvo, validarAlteracaoGuia(corpo));
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @Permissao('guias:gerir')
  cancelar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ id: string; situacao: 'cancelada' }> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return this.service.cancelarGuia(paraRequestContext(auth), alvo);
  }

  @Get(':id/consumos')
  @Permissao('guias:ler')
  consumos(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<ConsumoGuiaDto[]> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.service.consumos(paraRequestContext(auth), alvo);
  }

  /** Consome 1 sessão pelo agendamento (check-in/em atendimento/atendido). */
  @Post(':id/consumos')
  @Permissao('guias:consumir')
  consumir(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ResultadoConsumoDto> {
    const alvo = exigirUuid(id);
    return this.service.consumir(paraRequestContext(auth), alvo, validarConsumoGuia(corpo));
  }

  @Post(':id/consumos/:consumoId/estornar')
  @HttpCode(200)
  @Permissao('guias:consumir')
  estornar(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('consumoId') consumoId: string,
    @Body() corpo: unknown,
  ): Promise<ResultadoConsumoDto> {
    const alvo = exigirUuid(id);
    const consumo = exigirUuid(consumoId, 'consumoId');
    return this.service.estornar(paraRequestContext(auth), alvo, consumo, validarEstornoGuia(corpo));
  }

  /** Confirmação do paciente na sessão (sem biometria): `{meio: 'tela'|'papel', dispositivo?}`. */
  @Post(':id/consumos/:consumoId/assinatura')
  @Permissao('guias:consumir')
  assinar(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('consumoId') consumoId: string,
    @Body() corpo: unknown,
  ): Promise<{ id: string; assinadaEm: string; hash: string }> {
    const alvo = exigirUuid(id);
    const consumo = exigirUuid(consumoId, 'consumoId');
    return this.service.registrarAssinatura(paraRequestContext(auth), alvo, consumo, validarAssinatura(corpo));
  }
}

/** Pacotes de sessões (HU-FIN-004; `listarPacotes` da ApiClinica): criar, consumir, saldo e histórico. */
@Controller('pacotes')
@UseGuards(SessaoGuard)
export class PacotesController {
  constructor(
    @Inject(PacotesService) private readonly service: PacotesService,
    @Inject(VigilanciaDeLeituraService) private readonly vigilancia: VigilanciaDeLeituraService,
  ) {}

  @Get()
  @Permissao('guias:ler')
  async listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: PacoteDto[]; truncado: boolean }> {
    const filtro = validarFiltroPacotes(query);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.service.listar(ctx, filtro);
  }

  @Post()
  @Permissao('guias:gerir')
  criar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<PacoteDto> {
    return this.service.criar(paraRequestContext(auth), validarNovoPacote(corpo));
  }

  @Get(':id')
  @Permissao('guias:ler')
  obter(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<PacoteDto> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.service.obter(paraRequestContext(auth), alvo);
  }

  @Get(':id/historico')
  @Permissao('guias:ler')
  historico(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<{ pacote: PacoteDto; consumos: ConsumoPacoteDto[] }> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.service.historico(paraRequestContext(auth), alvo);
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @Permissao('guias:gerir')
  cancelar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<PacoteDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return this.service.cancelar(paraRequestContext(auth), alvo);
  }

  /** R13 do #65: troca do profissional fixado na venda — só com motivo, registrada e auditada. */
  @Post(':id/profissional')
  @HttpCode(200)
  @Permissao('guias:gerir')
  trocarProfissional(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<PacoteDto> {
    const alvo = exigirUuid(id);
    const { profissionalId, motivo } = validarTrocaProfissionalPacote(corpo);
    return this.service.trocarProfissional(paraRequestContext(auth), alvo, profissionalId, motivo);
  }

  @Post(':id/consumos')
  @Permissao('guias:consumir')
  consumir(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ResultadoConsumoPacoteDto> {
    const alvo = exigirUuid(id);
    return this.service.consumir(paraRequestContext(auth), alvo, validarConsumoPacote(corpo).agendamentoId);
  }

  @Post(':id/consumos/:consumoId/estornar')
  @HttpCode(200)
  @Permissao('guias:consumir')
  estornar(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Param('consumoId') consumoId: string,
    @Body() corpo: unknown,
  ): Promise<ResultadoConsumoPacoteDto> {
    const alvo = exigirUuid(id);
    const consumo = exigirUuid(consumoId, 'consumoId');
    return this.service.estornar(paraRequestContext(auth), alvo, consumo, validarEstornoPacote(corpo));
  }
}
