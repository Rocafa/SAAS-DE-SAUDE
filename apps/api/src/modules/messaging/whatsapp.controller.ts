import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Logger, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ConflitoError } from '../../common/erros-dominio';
import { exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { CABECALHO_ASSINATURA, lerEventosDoWebhook, WebhookInvalidoError } from './mensageiro-whatsapp';
import { WhatsappService } from './whatsapp.service';
import { validarConfiguracao, validarFiltroEnvios, validarNovoOptIn, validarRevogacao } from './whatsapp.validation';

/** Rotas da clínica (com sessão). Na URL só ids, datas e enums. */
@Controller()
@UseGuards(SessaoGuard)
export class WhatsappController {
  constructor(@Inject(WhatsappService) private readonly service: WhatsappService) {}

  @Get('whatsapp/configuracao')
  @Permissao('comunicacao:ler')
  configuracao(@Sessao() auth: AuthContext) {
    return this.service.obterConfiguracao(paraRequestContext(auth));
  }

  @Put('whatsapp/configuracao')
  @Permissao('comunicacao:configurar')
  salvar(@Sessao() auth: AuthContext, @Body() corpo: unknown) {
    return this.service.salvarConfiguracao(paraRequestContext(auth), validarConfiguracao(corpo));
  }

  @Get('whatsapp/modelos')
  @Permissao('comunicacao:ler')
  modelos() {
    return this.service.listarModelos();
  }

  /**
   * Modelo da clínica DESLIGADO (V3 do parecer #69): só os modelos da plataforma, lista fechada no
   * código. Volta só com um fluxo pendente -> aprovado pelo Guardião. O corpo nem é lido.
   */
  @Post('whatsapp/modelos')
  @Permissao('comunicacao:configurar')
  criarModelo(): never {
    throw new ConflitoError('modelo_da_clinica_desligado');
  }

  @Get('whatsapp/envios')
  @Permissao('comunicacao:ler')
  envios(@Sessao() auth: AuthContext, @Query() query: unknown) {
    return this.service.listarEnvios(paraRequestContext(auth), validarFiltroEnvios(query));
  }

  @Post('whatsapp/lembretes/execucao')
  @HttpCode(200)
  @Permissao('comunicacao:executar')
  executar(@Sessao() auth: AuthContext) {
    return this.service.executarLembretes(paraRequestContext(auth));
  }

  @Post('whatsapp/retencao/execucao')
  @HttpCode(200)
  @Permissao('comunicacao:executar')
  retencao(@Sessao() auth: AuthContext) {
    return this.service.executarRetencao(paraRequestContext(auth));
  }

  @Get('pacientes/:id/whatsapp/opt-in')
  @Permissao('comunicacao:ler')
  optIn(@Sessao() auth: AuthContext, @Param('id') id: string) {
    return this.service.obterOptIn(paraRequestContext(auth), exigirUuid(id));
  }

  @Post('pacientes/:id/whatsapp/opt-in')
  @Permissao('comunicacao:opt_in')
  registrarOptIn(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    return this.service.registrarOptIn(paraRequestContext(auth), exigirUuid(id), validarNovoOptIn(corpo));
  }

  @Post('pacientes/:id/whatsapp/opt-in/revogar')
  @HttpCode(200)
  @Permissao('comunicacao:opt_in')
  revogarOptIn(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    return this.service.revogarOptIn(paraRequestContext(auth), exigirUuid(id), validarRevogacao(corpo));
  }
}

interface RequisicaoComCorpoBruto {
  readonly rawBody?: Buffer;
  readonly body?: unknown;
}

/**
 * Webhook da Meta (SEM sessão: quem chama é o provedor). Barreiras, nesta ordem:
 * 1. canal desligado na plataforma: 404 (não revela nada);
 * 2. assinatura HMAC-SHA256 do corpo BRUTO (`X-Hub-Signature-256`) com o app secret: inválida, 401
 *    sem processar nada (log com marcador fixo, nunca o corpo);
 * 3. formato e limite (até 100 eventos; corpo grande já é 413 no body parser): 400;
 * 4. clínica pelo número de negócio (função SECURITY DEFINER); número desconhecido ou canal da clínica
 *    desligado: o evento é ignorado;
 * 5. idempotência por id do provedor e limite de respostas por envio (no serviço).
 * Responde 200 rápido com contagens (a Meta reentrega o que não receber 200).
 */
@Controller('whatsapp/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger('whatsapp-webhook');

  constructor(@Inject(WhatsappService) private readonly service: WhatsappService) {}

  @Get()
  inscricao(@Query('hub.mode') modo: unknown, @Query('hub.verify_token') token: unknown, @Query('hub.challenge') desafio: unknown): string {
    const mensageiro = this.service.adaptador;
    if (!mensageiro) throw new HttpException({ statusCode: 404, message: 'Não encontrado' }, 404);
    const r = mensageiro.desafioDaInscricao(modo, token, desafio);
    if (r === null) throw new HttpException({ statusCode: 403, message: 'Sem permissão' }, 403);
    return r;
  }

  @Post()
  @HttpCode(200)
  async receber(@Req() req: RequisicaoComCorpoBruto, @Headers(CABECALHO_ASSINATURA) assinatura: string | undefined): Promise<{ processados: number; ignorados: number }> {
    const mensageiro = this.service.adaptador;
    if (!mensageiro) throw new HttpException({ statusCode: 404, message: 'Não encontrado' }, 404);
    if (!req.rawBody || !mensageiro.assinaturaValida(req.rawBody, assinatura)) {
      this.logger.warn('WHATSAPP_WEBHOOK_ASSINATURA_INVALIDA');
      throw new HttpException({ statusCode: 401, message: 'Não autenticado' }, 401);
    }
    let eventos;
    try {
      eventos = lerEventosDoWebhook(req.body);
    } catch (e) {
      if (e instanceof WebhookInvalidoError) throw new HttpException({ statusCode: 400, message: 'Dados inválidos', campos: [e.motivo] }, 400);
      throw e;
    }
    return this.service.processarEventos(eventos);
  }
}
