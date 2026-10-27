import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { VigilanciaDeLeituraService } from '../patients/vigilancia-de-leitura';
import { CaixaService, type CaixaDto } from './caixa.service';
import { FinanceiroService, type CobrancaDto, type ConfiguracaoDto, type RecebimentoDto } from './financeiro.service';
import {
  validarAberturaCaixa,
  validarCancelamentoCobranca,
  validarCancelamentoRecibo,
  validarConfiguracao,
  validarCorpoVazio,
  validarEmissaoRecibo,
  validarEstorno,
  validarFechamentoCaixa,
  validarFiltroCaixa,
  validarFiltroContasAReceber,
  validarFiltroRecibos,
  validarLoteReceitaSaude,
  validarNovaCobranca,
  validarPerfilFiscal,
  validarQueryVazia,
  validarRecebimento,
  validarSaneamentoPagador,
} from './financeiro.validation';
import { RecibosService, type LoteReceitaSaudeDto, type ReciboDto, type ReciboResumoDto } from './recibos.service';

/**
 * Financeiro do MVP (rodada 15.2). Na URL só ids, datas e enums: nome, CPF e pagador vão no corpo
 * (`nome`, `cpf`, `pagador`... na query dão 400 `dado_na_url`). Nenhuma rota devolve conteúdo clínico.
 * Listas com nome/CPF de pacientes contam no limite por usuário (R5); o recibo conta como ficha aberta.
 */
@Controller('financeiro')
@UseGuards(SessaoGuard)
export class FinanceiroController {
  constructor(
    @Inject(FinanceiroService) private readonly financeiro: FinanceiroService,
    @Inject(CaixaService) private readonly caixa: CaixaService,
    @Inject(RecibosService) private readonly recibos: RecibosService,
    @Inject(VigilanciaDeLeituraService) private readonly vigilancia: VigilanciaDeLeituraService,
  ) {}

  // ---------------------------------------------------------------- configuração e perfil fiscal

  @Get('configuracao')
  @Permissao('financeiro:ler')
  configuracao(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<ConfiguracaoDto> {
    validarQueryVazia(query);
    return this.financeiro.obterConfiguracao(paraRequestContext(auth));
  }

  @Put('configuracao')
  @Permissao('financeiro:configurar')
  alterarConfiguracao(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ConfiguracaoDto> {
    return this.financeiro.alterarConfiguracao(paraRequestContext(auth), validarConfiguracao(corpo));
  }

  @Get('profissionais/:id/perfil-fiscal')
  @Permissao('financeiro:fiscal')
  perfilFiscal(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown) {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.financeiro.obterPerfilFiscal(paraRequestContext(auth), alvo);
  }

  @Put('profissionais/:id/perfil-fiscal')
  @Permissao('financeiro:fiscal')
  alterarPerfilFiscal(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const alvo = exigirUuid(id);
    return this.financeiro.alterarPerfilFiscal(paraRequestContext(auth), alvo, validarPerfilFiscal(corpo));
  }

  // ---------------------------------------------------------------- cobranças

  @Post('cobrancas')
  @Permissao('financeiro:operar')
  lancar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<CobrancaDto> {
    return this.financeiro.lancarCobranca(paraRequestContext(auth), validarNovaCobranca(corpo));
  }

  /** Contas a receber: `?de&ate` (vencimento, ≤ 31 dias), `situacao`, `pacienteId`, `profissionalId`. */
  @Get('contas-a-receber')
  @Permissao('financeiro:ler')
  async contasAReceber(@Sessao() auth: AuthContext, @Query() query: unknown) {
    const filtro = validarFiltroContasAReceber(query);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.financeiro.contasAReceber(ctx, filtro);
  }

  @Get('cobrancas/:id')
  @Permissao('financeiro:ler')
  obterCobranca(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown) {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.financeiro.obterCobranca(paraRequestContext(auth), alvo);
  }

  @Post('cobrancas/:id/cancelar')
  @HttpCode(200)
  @Permissao('financeiro:operar')
  cancelarCobranca(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<CobrancaDto> {
    const alvo = exigirUuid(id);
    return this.financeiro.cancelarCobranca(paraRequestContext(auth), alvo, validarCancelamentoCobranca(corpo));
  }

  @Post('cobrancas/:id/recebimentos')
  @Permissao('financeiro:operar')
  receber(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<RecebimentoDto> {
    const alvo = exigirUuid(id);
    return this.financeiro.receber(paraRequestContext(auth), alvo, validarRecebimento(corpo));
  }

  @Post('recebimentos/:id/estornar')
  @HttpCode(200)
  @Permissao('financeiro:estornar')
  estornar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const alvo = exigirUuid(id);
    return this.financeiro.estornar(paraRequestContext(auth), alvo, validarEstorno(corpo));
  }

  // ---------------------------------------------------------------- caixa

  @Post('caixas')
  @Permissao('financeiro:operar')
  abrirCaixa(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<CaixaDto> {
    return this.caixa.abrir(paraRequestContext(auth), validarAberturaCaixa(corpo));
  }

  /** Caixa do dia: `?data=AAAA-MM-DD` (padrão: hoje no fuso da clínica). */
  @Get('caixas')
  @Permissao('financeiro:ler')
  caixaDoDia(@Sessao() auth: AuthContext, @Query() query: unknown) {
    return this.caixa.doDia(paraRequestContext(auth), validarFiltroCaixa(query).data);
  }

  @Get('caixas/:id')
  @Permissao('financeiro:ler')
  obterCaixa(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<CaixaDto> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    return this.caixa.obter(paraRequestContext(auth), alvo);
  }

  @Post('caixas/:id/fechar')
  @HttpCode(200)
  @Permissao('financeiro:operar')
  fecharCaixa(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<CaixaDto> {
    const alvo = exigirUuid(id);
    return this.caixa.fechar(paraRequestContext(auth), alvo, validarFechamentoCaixa(corpo));
  }

  // ---------------------------------------------------------------- recibos

  /** Emite o recibo do recebimento (idempotente: recibo vivo existente volta igual, 200). */
  @Post('recebimentos/:id/recibo')
  @HttpCode(200)
  @Permissao('financeiro:operar')
  emitirRecibo(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ReciboDto> {
    const alvo = exigirUuid(id);
    return this.recibos.emitir(paraRequestContext(auth), alvo, validarEmissaoRecibo(corpo));
  }

  /**
   * Saneamento de `pagador_responsavel` (R2 do 2º parecer do #67): grava, uma vez, o responsável pagador
   * de um recebimento sem congelado (corpo `{vinculoId}`). `pagador_anulado` não se resolve aqui
   * (estorno e novo recebimento).
   */
  @Post('recebimentos/:id/pagador-responsavel')
  @HttpCode(200)
  @Permissao('financeiro:sanear_pagador')
  sanearPagador(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const alvo = exigirUuid(id);
    return this.recibos.resolverPagadorResponsavel(paraRequestContext(auth), alvo, validarSaneamentoPagador(corpo).vinculoId);
  }

  @Get('recibos')
  @Permissao('financeiro:ler')
  async listarRecibos(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: ReciboResumoDto[]; truncado: boolean }> {
    const filtro = validarFiltroRecibos(query);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.recibos.listar(ctx, filtro);
  }

  @Get('recibos/:id')
  @Permissao('financeiro:ler')
  async obterRecibo(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<ReciboDto> {
    const alvo = exigirUuid(id);
    validarQueryVazia(query);
    const ctx = paraRequestContext(auth);
    // Recibo traz nome e CPF: conta como ficha distinta aberta (alerta de anomalia, R5).
    await this.vigilancia.ficha(ctx, `recibo:${alvo}`);
    return this.recibos.obter(ctx, alvo);
  }

  /**
   * Via OFICIAL do recibo (N2 da conferência do #67): CPFs completos, para o IR do pagador. Só admin e
   * financeiro; a recepção entrega a via de conferência ("não vale para IR"). Conta como ficha aberta (R5).
   */
  @Post('recibos/:id/via-oficial')
  @HttpCode(200)
  @Permissao('recibos:emitir_via_oficial')
  async viaOficialRecibo(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ReciboDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.ficha(ctx, `recibo:${alvo}`);
    return this.recibos.emitirViaOficial(ctx, alvo);
  }

  @Post('recibos/:id/cancelar')
  @HttpCode(200)
  @Permissao('financeiro:estornar')
  cancelarRecibo(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ReciboDto> {
    const alvo = exigirUuid(id);
    return this.recibos.cancelar(paraRequestContext(auth), alvo, validarCancelamentoRecibo(corpo));
  }

  // ---------------------------------------------------------------- Receita Saúde (D14)

  /** Insumo em lote do profissional PF no período (corpo: `{profissionalId, de, ate}`, ≤ 31 dias). */
  @Post('receita-saude/lotes')
  @HttpCode(200)
  @Permissao('financeiro:fiscal')
  async loteReceitaSaude(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<LoteReceitaSaudeDto> {
    const filtro = validarLoteReceitaSaude(corpo);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.listagem(ctx);
    return this.recibos.loteReceitaSaude(ctx, filtro);
  }
}
