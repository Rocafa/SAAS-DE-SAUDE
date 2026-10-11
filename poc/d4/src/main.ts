/**
 * NestJS mínimo com o Better Auth montado em /api/auth/*.
 *
 * A rota /whoami existe para medir UM critério específico: a clínica chega ao servidor
 * pela SESSÃO, nunca pelo que o cliente manda. Ela ignora de propósito qualquer
 * cabeçalho ou corpo com tenant e devolve o que o servidor resolveu sozinho — é o
 * equivalente ao `withTenant` da API de verdade.
 */
import 'reflect-metadata';
import { All, Controller, Get, Module, Req, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';

const handler = toNodeHandler(auth);

@Controller()
class PocController {
  /** Tudo de /api/auth/* vai direto para o Better Auth. */
  @All('api/auth/*splat')
  autenticacao(@Req() req: Request, @Res() res: Response): void {
    void handler(req, res);
  }

  /**
   * Resolve a clínica do lado do servidor. O cliente pode mandar
   * `x-tenant-id` ou `?tenant=` à vontade: nada disso é lido aqui.
   */
  @Get('whoami')
  async whoami(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessao = await auth.api.getSession({ headers: new Headers(req.headers as Record<string, string>) });
    if (!sessao) {
      res.status(401).json({ erro: 'sem sessão' });
      return;
    }
    res.json({
      // Vem da sessão gravada no banco, não do que o cliente enviou.
      usuario: sessao.user.id,
      clinicaAtiva: (sessao.session as { activeOrganizationId?: string }).activeOrganizationId ?? null,
      // Devolvido só para a medição provar que o valor do cliente foi ignorado.
      clinicaQueOClienteAlegou: req.header('x-tenant-id') ?? null,
      sessaoExpiraEm: sessao.session.expiresAt,
    });
  }
}

@Module({ controllers: [PocController] })
class PocModule {}

async function subir(): Promise<void> {
  const app = await NestFactory.create(PocModule, { logger: ['error', 'warn'] });
  await app.listen(Number(process.env.POC_PORT ?? 8085), '127.0.0.1');
  process.stdout.write(`[poc] no ar em ${process.env.POC_BASE_URL ?? 'http://localhost:8085'}\n`);
}

void subir();
