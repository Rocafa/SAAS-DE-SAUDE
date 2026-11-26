import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { exigirObjeto, exigirUuid } from '../../common/validacao';
import { paraRequestContext, type AuthContext } from '../auth/auth-context';
import { Permissao, Sessao, SessaoGuard } from '../auth/sessao.guard';
import type { AgendamentoDto } from './scheduling.service';
import { ListaEsperaService, type ItemEsperaDto } from './lista-espera.service';
import { validarFiltroEspera, validarMarcacaoDaEspera, validarNovoItemEspera, validarRetirada } from './lista-espera.validation';

/**
 * Lista de espera (HU-AGD-009; semântica de listarEspera/adicionarEspera/removerEspera/devolverEspera da ApiClinica).
 * A OBSERVAÇÃO é curta (até 120 caracteres) e ADMINISTRATIVA — ex.: "prefere ser avisada por WhatsApp" — e NUNCA
 * leva dado clínico (queixa, diagnóstico, medicação): o motivo do atendimento é do prontuário. Ela é gravada só
 * cifrada e não vai para a trilha nem para log. Doc: docs/04-arquitetura/api-dominio.md §5b.
 */
@Controller('espera')
@UseGuards(SessaoGuard)
export class ListaEsperaController {
  constructor(@Inject(ListaEsperaService) private readonly service: ListaEsperaService) {}

  @Get()
  @Permissao('espera:ler')
  listar(@Sessao() auth: AuthContext, @Query() query: unknown): Promise<{ itens: ItemEsperaDto[]; truncado: boolean }> {
    return this.service.listar(paraRequestContext(auth), auth.perfis, validarFiltroEspera(query));
  }

  @Post()
  @Permissao('espera:escrever')
  adicionar(@Sessao() auth: AuthContext, @Body() corpo: unknown): Promise<ItemEsperaDto> {
    return this.service.adicionar(paraRequestContext(auth), validarNovoItemEspera(corpo));
  }

  /** Tira da lista (`?motivo=retirado|desistencia`, padrão `retirado`). Devolve o item, para o "Desfazer". */
  @Delete(':id')
  @Permissao('espera:escrever')
  retirar(@Sessao() auth: AuthContext, @Param('id') id: string, @Query() query: unknown): Promise<ItemEsperaDto> {
    const alvo = exigirUuid(id);
    return this.service.retirar(paraRequestContext(auth), alvo, validarRetirada(query));
  }

  /** "Desfazer" da retirada: o item volta na mesma posição. */
  @Post(':id/devolver')
  @HttpCode(200)
  @Permissao('espera:escrever')
  devolver(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<ItemEsperaDto> {
    const alvo = exigirUuid(id);
    exigirObjeto(corpo ?? {}, []);
    return this.service.devolver(paraRequestContext(auth), alvo);
  }

  /** Marca a partir da espera: cria o agendamento (regras do POST /agendamentos) e tira da lista, atomicamente. */
  @Post(':id/marcar')
  @Permissao('espera:escrever')
  marcar(@Sessao() auth: AuthContext, @Param('id') id: string, @Body() corpo: unknown): Promise<{ agendamento: AgendamentoDto; esperaId: string }> {
    const alvo = exigirUuid(id);
    return this.service.marcar(paraRequestContext(auth), alvo, validarMarcacaoDaEspera(corpo));
  }
}
