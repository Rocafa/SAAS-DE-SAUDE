/**
 * Ativação do fundador da clínica provisionada (B11, PR 2). Desenho v2: docs/04-arquitetura/provisionamento-da-clinica.md
 * §3; parecer do Guardião de 16/11/2026 (R2, R4, R5 e R8).
 *
 * `POST /ativacao/usar` é pública (o fundador ainda não tem sessão), como `/convites/aceitar` e `/recuperacao/usar`: rate
 * limit por IP e CSRF/origem da borda valem. O token vai SÓ no corpo (nunca na query: logs de ALB e CloudFront).
 * - Token inválido, vencido, usado, bloqueado, e-mail diferente ou fundador que não confere: o MESMO 404.
 * - Contador por origem fora do ar: 503 (falha fechada, BLOQUEIO_INDISPONIVEL).
 * - Conta nova: 204 com o cookie de uma sessão que só serve ao cadastro do TOTP (15 min, R8).
 * - Conta existente: login completo (senha e código TOTP); 204 sem cookie, a pessoa entra pelo login normal.
 */
import { Body, Controller, HttpCode, Inject, Injectable, NotFoundException, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { exigirObjeto, Validador } from '../../common/validacao';
import { origemDaRequisicao } from '../../security/log-de-seguranca';
import { AUTH_PROVIDER, ehProvedorDeAtivacao, type AuthProvider, type ProvedorDeAtivacao } from './auth-context';
import { CABECALHO_ORIGEM } from './better-auth/protecao';

@Injectable()
export class AtivacaoService {
  constructor(@Inject(AUTH_PROVIDER) private readonly provider: AuthProvider) {}

  private get ativacoes(): ProvedorDeAtivacao {
    if (!ehProvedorDeAtivacao(this.provider)) throw new NotFoundException({ statusCode: 404, message: 'Not Found' });
    return this.provider;
  }

  /** Devolve os `Set-Cookie` da sessão de cadastro (conta nova) ou nenhum (conta existente). */
  async usar(e: { token: string; email: string; senha: string; nome?: string; codigo?: string; cabecalhos: Headers }): Promise<string[]> {
    const r = await this.ativacoes.usarAtivacao(e);
    if (r === 'invalido') throw new NaoEncontradoError();
    if (r === 'indisponivel') throw new ServiceUnavailableException({ statusCode: 503, message: 'Serviço indisponível' });
    if (r === 'entrada_invalida') throw new ConflitoError('entrada_invalida');
    if (r === 'nome_obrigatorio') throw new ConflitoError('nome_obrigatorio', ['nome']);
    // Só chega aqui quem já passou pelo token e pelo e-mail: pedir o código não revela nada a quem não os tem.
    if (r === 'codigo_obrigatorio') throw new ConflitoError('conta_existente_exige_login', ['codigo']);
    if (r === 'senha_vazada') throw new ConflitoError('senha_vazada', ['senha']);
    // Senha ou código errados e bloqueio de login respondem igual.
    if (r === 'credencial_errada') throw new ConflitoError('credenciais_invalidas');
    if (r === 'conta_sem_fator') throw new ConflitoError('conta_sem_fator');
    return r.cookies;
  }
}

/** Uso do token de ativação: sem sessão. Rate limit e CSRF da borda valem. */
@Controller('ativacao')
export class AtivacaoController {
  constructor(@Inject(AtivacaoService) private readonly service: AtivacaoService) {}

  @Post('usar')
  @HttpCode(204)
  async usar(
    @Body() corpo: unknown,
    @Req() req: { headers: Record<string, string | string[] | undefined>; ip?: string },
    @Res({ passthrough: true }) res: { append(nome: string, valor: string[]): void },
  ): Promise<void> {
    const v = new Validador(exigirObjeto(corpo, ['token', 'email', 'nome', 'senha', 'codigo']));
    const token = v.texto('token', { max: 64, obrigatorio: true });
    const email = v.texto('email', { max: 320, obrigatorio: true });
    const nome = v.texto('nome', { max: 200 });
    const senha = v.texto('senha', { max: 128, obrigatorio: true });
    const codigo = v.texto('codigo', { max: 6 });
    v.concluir();
    // Entrada mal formada não gasta tentativa (R4).
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new ConflitoError('email_invalido', ['email']);
    if (senha.length < 12) throw new ConflitoError('senha_curta', ['senha']);
    const cabecalhos = new Headers();
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') cabecalhos.set('user-agent', ua);
    // Origem calculada no servidor (HMAC do IP), nunca aceita do cliente.
    const origem = origemDaRequisicao(req.ip);
    if (origem) cabecalhos.set(CABECALHO_ORIGEM, origem);
    const cookies = await this.service.usar({ token, email, senha, cabecalhos, ...(nome ? { nome } : {}), ...(codigo ? { codigo } : {}) });
    if (cookies.length > 0) res.append('Set-Cookie', cookies);
  }
}
