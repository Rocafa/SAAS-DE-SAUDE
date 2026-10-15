import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { exigirUuid } from '../../common/validacao';
import type { PsychCompartmentMode } from '../../db/schema';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import { VigilanciaDeLeituraService } from '../patients/vigilancia-de-leitura';
import { CicloNotasPrivadasService, type ResultadoDoCiclo } from './ciclo-notas-privadas';
import { NotasPrivadasService, type NotaPrivadaDto } from './notas-privadas.service';
import { ProntuarioService, type AtendimentoDto, type PaginaDeHistorico, type RespostaConfiguracao, type VersaoDto } from './prontuario.service';
import {
  validarAbertura,
  validarAdendo,
  validarAlteracaoNota,
  validarConfiguracao,
  validarCorpoVazioClinico,
  validarNovaNota,
  validarPaginacao,
  validarQueryVaziaClinica,
  validarRetencaoLegal,
  validarSalvamento,
} from './prontuario.validation';

/**
 * Atendimento e registro clínico (evolução). Todas as rotas exigem sessão; o guarda deixa os
 * perfis da clínica chegarem (`prontuario:acessar`) só para que a negação seja AUDITADA: o serviço
 * nega perfil não clínico antes de consultar qualquer coisa e chama o porteiro de conteúdo clínico
 * (vínculo de cuidado) em toda leitura/escrita. Na URL só ids e paginação.
 */
@Controller('atendimentos')
@UseGuards(SessaoGuard)
export class AtendimentosController {
  constructor(@Inject(ProntuarioService) private readonly service: ProntuarioService) {}

  /** Abre a partir do agendamento com check-in (idempotente: devolve o já aberto). */
  @Post()
  @HttpCode(200)
  @Permissao('prontuario:acessar')
  abrir(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<AtendimentoDto> {
    return this.service.abrir(paraRequestContext(auth), validarAbertura(corpo));
  }

  @Get(':id')
  @Permissao('prontuario:acessar')
  obter(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<AtendimentoDto> {
    const alvo = exigirUuid(id);
    validarQueryVaziaClinica(query);
    return this.service.obter(paraRequestContext(auth), alvo);
  }

  /** Salvar/editar a evolução (também o salvamento automático): cria uma versão nova. */
  @Put(':id/registro')
  @Permissao('prontuario:acessar')
  salvar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<AtendimentoDto> {
    const alvo = exigirUuid(id);
    return this.service.salvar(paraRequestContext(auth), alvo, validarSalvamento(corpo));
  }

  @Get(':id/versoes')
  @Permissao('prontuario:acessar')
  versoes(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<VersaoDto[]> {
    const alvo = exigirUuid(id);
    validarQueryVaziaClinica(query);
    return this.service.versoes(paraRequestContext(auth), alvo);
  }

  @Post(':id/finalizar')
  @HttpCode(200)
  @Permissao('prontuario:acessar')
  finalizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<AtendimentoDto> {
    const alvo = exigirUuid(id);
    validarCorpoVazioClinico(corpo);
    return this.service.finalizar(paraRequestContext(auth), alvo);
  }

  @Post(':id/adendos')
  @Permissao('prontuario:acessar')
  adendo(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<AtendimentoDto> {
    const alvo = exigirUuid(id);
    return this.service.adendo(paraRequestContext(auth), alvo, validarAdendo(corpo));
  }
}

/** Histórico clínico e notas privadas a partir do paciente. */
@Controller('pacientes')
@UseGuards(SessaoGuard)
export class ProntuarioDoPacienteController {
  constructor(
    @Inject(ProntuarioService) private readonly prontuario: ProntuarioService,
    @Inject(NotasPrivadasService) private readonly notas: NotasPrivadasService,
    @Inject(VigilanciaDeLeituraService) private readonly vigilancia: VigilanciaDeLeituraService,
  ) {}

  /** `?pagina=1&limite=20` (limite ≤ 50). Conta como ficha aberta na vigilância de leitura (R5). */
  @Get(':id/prontuario')
  @Permissao('prontuario:acessar')
  async historico(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<PaginaDeHistorico> {
    const paciente = exigirUuid(id);
    const pag = validarPaginacao(query);
    const ctx = paraRequestContext(auth);
    await this.vigilancia.ficha(ctx, `prontuario:${paciente}`);
    return this.prontuario.historico(ctx, paciente, pag);
  }

  @Get(':id/notas-privadas')
  @Permissao('prontuario:acessar')
  listarNotas(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<NotaPrivadaDto[]> {
    const paciente = exigirUuid(id);
    validarQueryVaziaClinica(query);
    return this.notas.listar(paraRequestContext(auth), paciente);
  }

  @Post(':id/notas-privadas')
  @Permissao('prontuario:acessar')
  criarNota(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<NotaPrivadaDto> {
    const paciente = exigirUuid(id);
    return this.notas.criar(paraRequestContext(auth), paciente, validarNovaNota(corpo));
  }
}

/** Nota privada pelo id: só o autor (outro autor = 404 + tentativa auditada). */
@Controller('notas-privadas')
@UseGuards(SessaoGuard)
export class NotasPrivadasController {
  constructor(@Inject(NotasPrivadasService) private readonly notas: NotasPrivadasService) {}

  @Get(':id')
  @Permissao('prontuario:acessar')
  obter(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<NotaPrivadaDto> {
    const alvo = exigirUuid(id);
    validarQueryVaziaClinica(query);
    return this.notas.obter(paraRequestContext(auth), alvo);
  }

  @Patch(':id')
  @Permissao('prontuario:acessar')
  atualizar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<NotaPrivadaDto> {
    const alvo = exigirUuid(id);
    return this.notas.atualizar(paraRequestContext(auth), alvo, validarAlteracaoNota(corpo));
  }

  /** "Excluir" = descartar: some da API; a linha cifrada fica (sem DELETE para o runtime). */
  @Post(':id/descartar')
  @HttpCode(200)
  @Permissao('prontuario:acessar')
  descartar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ id: string; descartadaEm: string }> {
    const alvo = exigirUuid(id);
    validarCorpoVazioClinico(corpo);
    return this.notas.descartar(paraRequestContext(auth), alvo);
  }
}

/** Sigilo do compartimento de psicologia (1.11 em aberto). Só o dono da clínica. */
@Controller('prontuario')
@UseGuards(SessaoGuard)
export class ConfiguracaoProntuarioController {
  constructor(@Inject(ProntuarioService) private readonly service: ProntuarioService) {}

  @Get('configuracao')
  @Permissao('prontuario:configurar')
  obter(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ psicologia: PsychCompartmentMode }> {
    validarQueryVaziaClinica(query);
    return this.service.obterConfiguracao(paraRequestContext(auth));
  }

  @Put('configuracao')
  @Permissao('prontuario:configurar')
  definir(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<RespostaConfiguracao> {
    return this.service.definirConfiguracao(paraRequestContext(auth), validarConfiguracao(corpo));
  }
}

/**
 * Ciclo das notas privadas e retenção legal (D1 e D2 do parecer #63). Só o dono da clínica, e ele
 * nunca vê conteúdo: só contagens.
 */
@Controller('prontuario')
@UseGuards(SessaoGuard)
export class CicloNotasPrivadasController {
  constructor(@Inject(CicloNotasPrivadasService) private readonly ciclo: CicloNotasPrivadasService) {}

  /** Prazos de custódia e expurgo sob demanda (o job diário chama o mesmo serviço). Idempotente. */
  @Post('notas-privadas/ciclo')
  @HttpCode(200)
  @Permissao('prontuario:configurar')
  executar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ResultadoDoCiclo> {
    validarCorpoVazioClinico(corpo);
    return this.ciclo.executarCicloDasNotas(paraRequestContext(auth));
  }

  /** Desligamento do profissional: as notas dele ficam aguardando decisão por 30 dias (só a contagem). */
  @Post('profissionais/:id/desligamento')
  @HttpCode(200)
  @Permissao('prontuario:configurar')
  desligar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ notas: number; prazo: string }> {
    const alvo = exigirUuid(id);
    validarCorpoVazioClinico(corpo);
    return this.ciclo.iniciarDesligamento(paraRequestContext(auth), alvo);
  }

  /** Retenção legal do paciente (requisição judicial, da ANPD ou processo ético): suspende o expurgo. */
  @Put('pacientes/:id/retencao-legal')
  @Permissao('prontuario:configurar')
  retencao(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ retencaoLegalDesde: string | null }> {
    const alvo = exigirUuid(id);
    return this.ciclo.definirRetencaoLegal(paraRequestContext(auth), alvo, validarRetencaoLegal(corpo));
  }
}
