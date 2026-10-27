import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EntradaInvalidaError, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { toCsv } from '../exports/csv';
import { CAMPOS, OBRIGATORIOS, TERMO_MIGRACAO_VERSAO } from './importacao-regras';
import { ImportacaoService, type LoteDto, type RecebidoDto, type RelatorioDto } from './importacao.service';
import {
  lerArquivoCsv,
  lerCorpoLimitado,
  traduzirPlanilhaAsync,
  validarAplicacao,
  validarCorpoVazio,
  validarEnvio,
  validarMapeamento,
  validarQuery,
} from './importacao.validation';
import { IMPORT_MAX_BYTES, IMPORT_MAX_LINHAS } from './planilha-csv';
import { TERMO_MIGRACAO_SHA256, TERMO_MIGRACAO_TEXTO } from './termo-migracao';

/**
 * Importador de planilha (rodada 17.3). SÓ admin (`importacao:gerir`; o banco confere de novo o perfil em
 * clinic_members). Na URL só ids, o tipo do lote e a versão do termo; o arquivo é o corpo `text/csv`.
 */
@Controller('importacoes')
@UseGuards(SessaoGuard)
export class ImportacaoController {
  constructor(@Inject(ImportacaoService) private readonly importacao: ImportacaoService) {}

  /** Versão vigente do termo de migração e limites, para a tela pedir o aceite antes do envio. */
  @Get('termo')
  @Permissao('importacao:gerir')
  termo(@Query() query: unknown) {
    validarQuery(query);
    return { versao: TERMO_MIGRACAO_VERSAO, texto: TERMO_MIGRACAO_TEXTO, textoSha256: TERMO_MIGRACAO_SHA256, formatos: ['csv'], maxBytes: IMPORT_MAX_BYTES, maxLinhas: IMPORT_MAX_LINHAS, campos: CAMPOS, obrigatorios: OBRIGATORIOS };
  }

  /** `POST /importacoes?tipo=pacientes|agenda&termo=<versão aceita>` com o CSV no corpo. */
  @Post()
  @Permissao('importacao:gerir')
  async enviar(@Sessao() auth: AuthContext, @Query() query: unknown, @Req() req: IncomingMessage): Promise<RecebidoDto> {
    let envio: { tipo: 'pacientes' | 'agenda'; termo: string };
    try {
      envio = validarEnvio(query);
    } catch (e) {
      // Recusa sem ler: drena o corpo sem guardar, para o cliente receber a resposta.
      await lerCorpoLimitado(req, 0).catch(() => undefined);
      throw e;
    }
    const { tipo, termo } = envio;
    const bytes = await lerArquivoCsv(req);
    return traduzirPlanilhaAsync(this.importacao.receber(paraRequestContext(auth), tipo, termo, bytes));
  }

  @Get()
  @Permissao('importacao:gerir')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<LoteDto[]> {
    validarQuery(query);
    return this.importacao.listar(paraRequestContext(auth));
  }

  @Get(':id')
  @Permissao('importacao:gerir')
  obter(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<LoteDto> {
    const alvo = exigirUuid(id);
    validarQuery(query);
    return this.importacao.obter(paraRequestContext(auth), alvo);
  }

  @Put(':id/mapeamento')
  @Permissao('importacao:gerir')
  mapear(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<LoteDto> {
    const alvo = exigirUuid(id);
    return this.importacao.mapear(paraRequestContext(auth), alvo, validarMapeamento(corpo));
  }

  @Post(':id/validar')
  @HttpCode(200)
  @Permissao('importacao:gerir')
  validar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<RelatorioDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return traduzirPlanilhaAsync(this.importacao.validar(paraRequestContext(auth), alvo));
  }

  /** Dry-run: nada é criado; devolve o relatório e o `resumoHash` que o APLICAR exige. */
  @Post(':id/simular')
  @HttpCode(200)
  @Permissao('importacao:gerir')
  simular(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return traduzirPlanilhaAsync(this.importacao.simular(paraRequestContext(auth), alvo));
  }

  /** `?formato=json` (padrão) ou `csv` (fórmulas neutralizadas, CWE-1236). */
  @Get(':id/divergencias')
  @Permissao('importacao:gerir')
  async divergencias(
    @Sessao() auth: AuthContext,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<RelatorioDto | string> {
    const alvo = exigirUuid(id);
    const q = validarQuery(query, ['formato']);
    const formato = q.formato ?? 'json';
    if (formato !== 'json' && formato !== 'csv') throw new EntradaInvalidaError(['formato']);
    const rel = await traduzirPlanilhaAsync(this.importacao.divergencias(paraRequestContext(auth), alvo));
    if (formato === 'json') return rel;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="divergencias.csv"');
    return toCsv(
      ['linha', 'campo', 'codigo', 'gravidade', 'valor'],
      rel.divergencias.map((d) => [d.linha, d.campo, d.codigo, d.gravidade, d.valor]),
    );
  }

  @Post(':id/aplicar')
  @HttpCode(200)
  @Permissao('importacao:gerir')
  aplicar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<LoteDto> {
    const alvo = exigirUuid(id);
    const { resumoHash, clinicaConfirmada } = validarAplicacao(corpo);
    return traduzirPlanilhaAsync(this.importacao.aplicar(paraRequestContext(auth), alvo, resumoHash, clinicaConfirmada));
  }

  @Post(':id/desfazer')
  @HttpCode(200)
  @Permissao('importacao:gerir')
  desfazer(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<LoteDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazio(corpo);
    return this.importacao.desfazer(paraRequestContext(auth), alvo);
  }
}
