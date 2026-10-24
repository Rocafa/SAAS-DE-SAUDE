import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { CorpoPortal, PortalTipoDePedidoAceito, RespostaPortal } from '@plataforma/shared';
import { EntradaInvalidaError, exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { PORTAL_CONSENT_PURPOSES, PORTAL_LINK_REVOKE_REASONS, PORTAL_ACTING_AS, type PortalConsentPurpose } from '../../db/schema';
import type { RequisicaoParaSessao } from '../auth/auth-context';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { PortalGuard, RequisicaoPortal, SessaoPortal, type SessaoDoPortal } from './portal-auth';
import { PortalClinicaService } from './portal-clinica.service';
import { hojeNaClinica } from '../insurance/guias-regras';
import { nascimentoPropostoValido, TIPOS_DE_PEDIDO_ACEITOS, tipoDePedido, VALIDADE_CONVITE_HORAS } from './portal-regras';
import { PortalService } from './portal.service';

/** GET do portal não aceita NENHUM parâmetro de query (nada de pacienteId/tenantId/vinculoId). */
function semQuery(query: unknown): void {
  exigirObjeto(query ?? {}, []);
}

function finalidade(valor: string): PortalConsentPurpose {
  if (!(PORTAL_CONSENT_PURPOSES as readonly string[]).includes(valor)) throw new EntradaInvalidaError(['finalidade']);
  return valor as PortalConsentPurpose;
}

/**
 * PORTAL DO PACIENTE (contrato ApiPortal; veto B3 do front-r8). Só a sessão do portal entra
 * (PortalGuard). Nenhuma rota recebe id de paciente ou de clínica: o titular é o do vínculo da sessão.
 * Ids na URL só de consulta/recibo, conferidos contra o titular no servidor (alheio = 404).
 */
@Controller('portal')
@UseGuards(PortalGuard)
export class PortalController {
  constructor(@Inject(PortalService) private readonly service: PortalService) {}

  @Get('vinculos')
  vinculos(@SessaoPortal() s: SessaoDoPortal, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/vinculos'>> {
    semQuery(q);
    return this.service.vinculos(s);
  }

  @Get('sessao')
  sessao(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/sessao'>> {
    semQuery(q);
    return this.service.sessaoAtual(s, req);
  }

  @Post('sessao/vinculo')
  @HttpCode(200)
  escolher(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/sessao/vinculo'>> {
    const v = new Validador(exigirObjeto(corpo, ['vinculoId']));
    const vinculoId = v.uuid('vinculoId', true);
    v.concluir();
    return this.service.escolherVinculo(s, req, vinculoId as string);
  }

  /**
   * Resgate em dois passos (A2 do #68). O token vai SÓ no corpo (nunca na URL: query é 400). O link que
   * chega ao paciente leva o token no `#fragmento` (não vai ao servidor nem ao Referer) ou como código
   * digitado; nenhum log de requisição grava o corpo destas rotas.
   */
  @Post('convites/resgate')
  @HttpCode(200)
  iniciarResgate(@SessaoPortal() s: SessaoDoPortal, @Query() q: unknown, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/convites/resgate'>> {
    semQuery(q);
    const v = new Validador(exigirObjeto(corpo, ['token']));
    const token = v.texto('token', { min: 1, max: 128, obrigatorio: true });
    v.concluir();
    const pedido: CorpoPortal<'POST /portal/convites/resgate'> = { token };
    return this.service.iniciarResgate(s, pedido.token);
  }

  @Post('convites/resgate/confirmar')
  @HttpCode(200)
  resgatar(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/convites/resgate/confirmar'>> {
    semQuery(q);
    const v = new Validador(exigirObjeto(corpo, ['token', 'codigo']));
    const token = v.texto('token', { min: 1, max: 128, obrigatorio: true });
    const codigo = v.texto('codigo', { min: 1, max: 16, obrigatorio: true });
    v.concluir();
    const pedido: CorpoPortal<'POST /portal/convites/resgate/confirmar'> = { token, codigo };
    return this.service.resgatar(s, req, pedido.token, pedido.codigo);
  }

  @Get('consultas')
  consultas(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/consultas'>> {
    semQuery(q);
    return this.service.minhasConsultas(s, req);
  }

  @Post('consultas/:id/confirmar')
  @HttpCode(200)
  confirmar(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Param('id') id: string, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/consultas/:id/confirmar'>> {
    exigirObjeto(corpo ?? {}, []);
    return this.service.agirNaConsulta(s, req, exigirUuid(id), 'confirmar');
  }

  @Post('consultas/:id/desfazer-confirmacao')
  @HttpCode(200)
  desfazer(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Param('id') id: string, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/consultas/:id/desfazer-confirmacao'>> {
    exigirObjeto(corpo ?? {}, []);
    return this.service.agirNaConsulta(s, req, exigirUuid(id), 'desfazer_confirmacao');
  }

  @Post('consultas/:id/cancelar')
  @HttpCode(200)
  cancelar(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Param('id') id: string, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/consultas/:id/cancelar'>> {
    exigirObjeto(corpo ?? {}, []);
    return this.service.agirNaConsulta(s, req, exigirUuid(id), 'cancelar');
  }

  @Get('recibos')
  recibos(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/recibos'>> {
    semQuery(q);
    return this.service.meusRecibos(s, req);
  }

  @Get('recibos/:id')
  recibo(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Param('id') id: string, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/recibos/:id'>> {
    semQuery(q);
    return this.service.meuRecibo(s, req, exigirUuid(id));
  }

  @Get('documentos')
  documentos(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/documentos'>> {
    semQuery(q);
    return this.service.meusDocumentos(s, req);
  }

  @Get('meus-dados')
  meusDados(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/meus-dados'>> {
    semQuery(q);
    return this.service.meusDados(s, req);
  }

  /** "Solicitar correção" dos dados cadastrais: vira pedido `correcao` (art. 18, III) para a clínica. */
  @Post('meus-dados/correcao')
  correcao(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/meus-dados/correcao'>> {
    const v = new Validador(exigirObjeto(corpo, ['detalhe', 'nascimento']));
    const detalhe = v.texto('detalhe', { min: 3, max: 500, obrigatorio: true });
    // C1: a data de nascimento NÃO se edita pelo portal; aqui ela só vai, cifrada, para a clínica analisar.
    const nascimento = v.texto('nascimento', { min: 10, max: 10 });
    if (nascimento !== undefined && !nascimentoPropostoValido(nascimento, hojeNaClinica())) v.falhar('nascimento');
    v.concluir();
    const pedido: CorpoPortal<'POST /portal/meus-dados/correcao'> = { detalhe, ...(nascimento ? { nascimento } : {}) };
    return this.service.abrirPedido(s, req, 'correcao', pedido.detalhe, pedido.nascimento);
  }

  @Get('solicitacoes')
  pedidos(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/solicitacoes'>> {
    semQuery(q);
    return this.service.meusPedidos(s, req);
  }

  @Post('solicitacoes')
  abrir(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Body() corpo: unknown): Promise<RespostaPortal<'POST /portal/solicitacoes'>> {
    const v = new Validador(exigirObjeto(corpo, ['tipo', 'detalhe']));
    const bruto = v.umDe('tipo', TIPOS_DE_PEDIDO_ACEITOS, true);
    const detalhe = v.texto('detalhe', { min: 3, max: 500 });
    v.concluir();
    const pedido: CorpoPortal<'POST /portal/solicitacoes'> = { tipo: bruto as PortalTipoDePedidoAceito, ...(detalhe ? { detalhe } : {}) };
    const tipo = tipoDePedido(pedido.tipo);
    if (!tipo) throw new EntradaInvalidaError(['tipo']);
    return this.service.abrirPedido(s, req, tipo, pedido.detalhe);
  }

  @Get('privacidade/consentimentos')
  consentimentos(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/privacidade/consentimentos'>> {
    semQuery(q);
    return this.service.meusConsentimentos(s, req);
  }

  @Post('privacidade/consentimentos/:finalidade')
  @HttpCode(200)
  responder(
    @SessaoPortal() s: SessaoDoPortal,
    @RequisicaoPortal() req: RequisicaoParaSessao,
    @Param('finalidade') f: string,
    @Body() corpo: unknown,
  ): Promise<RespostaPortal<'POST /portal/privacidade/consentimentos/:finalidade'>> {
    const v = new Validador(exigirObjeto(corpo, ['resposta']));
    const resposta = v.umDe('resposta', ['sim', 'nao'] as const, true);
    v.concluir();
    const pedido: CorpoPortal<'POST /portal/privacidade/consentimentos/:finalidade'> = { resposta: resposta as 'sim' | 'nao' };
    return this.service.responderConsentimento(s, req, finalidade(f), pedido.resposta);
  }

  @Post('privacidade/consentimentos/:finalidade/desfazer')
  @HttpCode(200)
  desfazerConsentimento(
    @SessaoPortal() s: SessaoDoPortal,
    @RequisicaoPortal() req: RequisicaoParaSessao,
    @Param('finalidade') f: string,
    @Body() corpo: unknown,
  ): Promise<RespostaPortal<'POST /portal/privacidade/consentimentos/:finalidade/desfazer'>> {
    exigirObjeto(corpo ?? {}, []);
    return this.service.responderConsentimento(s, req, finalidade(f), 'desfeito');
  }

  @Get('privacidade/consentimentos/:finalidade/historico')
  historico(@SessaoPortal() s: SessaoDoPortal, @RequisicaoPortal() req: RequisicaoParaSessao, @Param('finalidade') f: string, @Query() q: unknown): Promise<RespostaPortal<'GET /portal/privacidade/consentimentos/:finalidade/historico'>> {
    semQuery(q);
    return this.service.historicoConsentimento(s, req, finalidade(f));
  }
}

/**
 * Lado da CLÍNICA do portal (sessão da clínica, SessaoGuard): convites, vínculos, pedidos do titular e
 * consentimentos do paciente.
 */
@Controller('clinica/portal')
@UseGuards(SessaoGuard)
export class PortalClinicaController {
  constructor(@Inject(PortalClinicaService) private readonly service: PortalClinicaService) {}

  @Post('convites')
  @Permissao('portal:convidar')
  convidar(@Sessao() auth: AuthContext, @Body() corpo: unknown) {
    const v = new Validador(exigirObjeto(corpo, ['pacienteId', 'agindoComo', 'validadeHoras', 'responsavelId']));
    const pacienteId = v.uuid('pacienteId', true);
    const agindoComo = v.umDe('agindoComo', PORTAL_ACTING_AS, false) ?? 'titular';
    const validadeHoras = v.inteiro('validadeHoras', { min: VALIDADE_CONVITE_HORAS.min, max: VALIDADE_CONVITE_HORAS.max }) ?? VALIDADE_CONVITE_HORAS.padrao;
    // V1 do #68: responsável legal = o vínculo de responsável (0028) do paciente que vai usar o portal.
    const responsavelId = v.uuid('responsavelId', false);
    v.concluir();
    return this.service.emitirConvite(paraRequestContext(auth), {
      pacienteId: pacienteId as string,
      agindoComo,
      validadeHoras,
      ...(responsavelId ? { responsavelId } : {}),
    });
  }

  @Post('convites/:id/revogar')
  @HttpCode(200)
  @Permissao('portal:convidar')
  revogarConvite(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    exigirObjeto(corpo ?? {}, []);
    return this.service.revogarConvite(paraRequestContext(auth), exigirUuid(id));
  }

  @Get('pacientes/:id/vinculos')
  @Permissao('portal:convidar')
  vinculos(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() q: unknown) {
    exigirObjeto(q ?? {}, []);
    return this.service.vinculosDoPaciente(paraRequestContext(auth), exigirUuid(id));
  }

  @Post('vinculos/:id/revogar')
  @HttpCode(200)
  @Permissao('portal:convidar')
  revogarVinculo(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const v = new Validador(exigirObjeto(corpo, ['motivo']));
    const motivo = v.umDe('motivo', PORTAL_LINK_REVOKE_REASONS, true);
    v.concluir();
    return this.service.revogarVinculo(paraRequestContext(auth), exigirUuid(id), motivo as (typeof PORTAL_LINK_REVOKE_REASONS)[number]);
  }

  @Get('pacientes/:id/consentimentos')
  @Permissao('pacientes:ler')
  consentimentos(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() q: unknown) {
    exigirObjeto(q ?? {}, []);
    return this.service.consentimentosDoPaciente(paraRequestContext(auth), exigirUuid(id));
  }

  @Get('solicitacoes')
  @Permissao('titular:atender')
  pedidos(@Sessao() auth: AuthContext, @Query() q: unknown) {
    const v = new Validador(exigirObjeto(q ?? {}, ['situacao']));
    const situacao = v.umDe('situacao', ['abertos', 'todos'] as const, false) ?? 'abertos';
    v.concluir();
    return this.service.pedidos(paraRequestContext(auth), { situacao });
  }

  @Get('solicitacoes/:id')
  @Permissao('titular:atender')
  pedido(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() q: unknown) {
    exigirObjeto(q ?? {}, []);
    return this.service.pedido(paraRequestContext(auth), exigirUuid(id));
  }

  @Post('solicitacoes/:id/situacao')
  @HttpCode(200)
  @Permissao('titular:atender')
  atualizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown) {
    const v = new Validador(exigirObjeto(corpo, ['situacao', 'resposta', 'documentoConferido']));
    const situacao = v.umDe('situacao', ['em_andamento', 'atendida', 'recusada'] as const, true);
    const resposta = v.texto('resposta', { min: 3, max: 1000 });
    // C1: correção de nascimento que reduz a idade de paciente com 12+ só é atendida com documento conferido.
    const documentoConferido = v.booleano('documentoConferido');
    v.concluir();
    return this.service.atualizarPedido(paraRequestContext(auth), exigirUuid(id), {
      situacao: situacao as 'em_andamento' | 'atendida' | 'recusada',
      ...(resposta ? { resposta } : {}),
      ...(documentoConferido !== undefined ? { documentoConferido } : {}),
    });
  }
}
