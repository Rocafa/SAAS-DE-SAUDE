/**
 * Rotas da pessoa SEM clínica ativa (D4, PR 3a; desenho §14.1, R3 a R6 do parecer do desenho do PR 3).
 *
 * Quem tem várias clínicas termina o login sem clínica ativa, e o `SessaoGuard` (que exige clínica) devolve 401. Estas
 * rotas usam o `SessaoDePessoaGuard`: só o provedor real (com o dev provider, 404), as mesmas travas da sessão (prazo
 * absoluto de 12 h, conta ativa) e NENHUMA leitura de clínica ou perfil. Entregam só o que é da própria pessoa.
 */
import {
  Body,
  CanActivate,
  Controller,
  createParamDecorator,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { exigirObjeto, exigirUuid, Validador } from '../../common/validacao';
import { origemDaRequisicao, registrarEventoDeSeguranca } from '../../security/log-de-seguranca';
import {
  AUTH_PROVIDER,
  ehProvedorDePessoa,
  type AuthProvider,
  type ClinicaDaPessoa,
  type ProvedorDePessoa,
  type RequisicaoParaSessao,
  type SessaoDePessoa,
  type SessaoListada,
} from './auth-context';

type RequisicaoComPessoa = RequisicaoParaSessao & { pessoa?: SessaoDePessoa; ip?: string };

@Injectable()
export class SessaoDePessoaGuard implements CanActivate {
  constructor(@Inject(AUTH_PROVIDER) private readonly provider: AuthProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Só o provedor real tem sessão sem clínica; o dev provider não expõe estas rotas.
    if (!ehProvedorDePessoa(this.provider)) throw new NotFoundException({ statusCode: 404, message: 'Not Found' });
    const req = context.switchToHttp().getRequest<RequisicaoComPessoa>();
    const res = context.switchToHttp().getResponse<{ append?: (nome: string, valor: string[]) => void }>();
    const pessoa = await this.provider.sessaoDePessoa({ headers: req.headers, aoRenovarCookie: (cookies) => res.append?.('Set-Cookie', cookies) });
    if (!pessoa) {
      registrarEventoDeSeguranca('SESSAO_INVALIDA', { origem: origemDaRequisicao(req.ip) });
      throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
    }
    req.pessoa = pessoa;
    return true;
  }
}

export const Pessoa = createParamDecorator((_: unknown, ctx: ExecutionContext): SessaoDePessoa => {
  const pessoa = ctx.switchToHttp().getRequest<RequisicaoComPessoa>().pessoa;
  if (!pessoa) throw new UnauthorizedException({ statusCode: 401, message: 'Não autenticado' });
  return pessoa;
});

@Controller('sessao')
@UseGuards(SessaoDePessoaGuard)
export class SessaoDaPessoaController {
  constructor(@Inject(AUTH_PROVIDER) private readonly provider: AuthProvider) {}

  private get pessoas(): ProvedorDePessoa {
    if (!ehProvedorDePessoa(this.provider)) throw new NotFoundException({ statusCode: 404, message: 'Not Found' });
    return this.provider;
  }

  /** Clínicas em que a pessoa tem vínculo ativo: id e nome. */
  @Get('clinicas')
  clinicas(@Pessoa() p: SessaoDePessoa): Promise<ClinicaDaPessoa[]> {
    return this.pessoas.clinicasDaPessoa(p.userId);
  }

  /** Escolhe a clínica ativa. Sem vínculo: 404 (não confirma que a clínica existe). */
  @Post('clinica')
  @HttpCode(204)
  async escolher(@Pessoa() p: SessaoDePessoa, @Body() corpo: unknown): Promise<void> {
    const v = new Validador(exigirObjeto(corpo, ['clinicaId']));
    const clinicaId = v.uuid('clinicaId', true) as string;
    v.concluir();
    if (!(await this.pessoas.escolherClinica(p, clinicaId))) throw new NaoEncontradoError();
  }

  /** As sessões abertas da própria pessoa (R20): sem IP, user-agent nem clínica. */
  @Get('sessoes')
  sessoes(@Pessoa() p: SessaoDePessoa): Promise<SessaoListada[]> {
    return this.pessoas.sessoesDaPessoa(p);
  }

  /** Encerra uma sessão da própria pessoa; de outra pessoa, 404. */
  @Delete('sessoes/:id')
  @HttpCode(204)
  async encerrar(@Pessoa() p: SessaoDePessoa, @Param('id') id: string): Promise<void> {
    if (!(await this.pessoas.encerrarSessaoDaPessoa(p, exigirUuid(id, 'id')))) throw new NaoEncontradoError();
  }

  /** Logout global: encerra todas as sessões da pessoa, inclusive esta. */
  @Post('encerrar-todas')
  @HttpCode(204)
  async encerrarTodas(@Pessoa() p: SessaoDePessoa): Promise<void> {
    await this.pessoas.encerrarTodasDaPessoa(p);
  }
}
