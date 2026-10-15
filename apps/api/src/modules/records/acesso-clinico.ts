/**
 * Negação auditada do acesso clínico (HU-PRO-005/006/009/022: "o acesso é negado e auditado").
 *
 * O porteiro (`exigirConteudoClinico`) lança 403 dentro da transação da operação, que então é
 * desfeita — e com ela qualquer auditoria gravada ali. Por isso a NEGAÇÃO é gravada aqui, numa
 * transação própria da clínica da sessão, depois do rollback. Metadata só com a operação, o motivo
 * (código) e ids opacos; nunca conteúdo.
 */
import { HttpException } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import type { AuditMetadata } from '../../db/schema';
import { recordAudit } from '../audit/audit-log';
import { ehPerfil, temPermissao } from '../auth/perfis';
import type { TenantDatabase } from '../tenancy/tenancy.module';

export const SCOPE_ACESSO_NEGADO = 'clinical_access_denied';

/** Motivos de 403 do prontuário que são TENTATIVA de acesso (e por isso auditados). */
const MOTIVOS_AUDITADOS = new Set(['sem_vinculo_de_cuidado', 'sigilo_psicologia', 'somente_o_autor']);

/**
 * Nota privada de OUTRO autor: para quem pediu, é igual a inexistente (404, não revela que existe);
 * para a trilha, é tentativa negada.
 */
export class NotaDeOutroAutorError extends NaoEncontradoError {
  constructor(readonly notaId: string) {
    super();
  }
}

function motivoDe(e: unknown): string | null {
  if (e instanceof NotaDeOutroAutorError) return 'nota_de_outro_autor';
  if (!(e instanceof ProibidoError) || !(e instanceof HttpException)) return null;
  const resposta = e.getResponse() as { codigo?: unknown };
  return typeof resposta.codigo === 'string' && MOTIVOS_AUDITADOS.has(resposta.codigo) ? resposta.codigo : null;
}

export interface AlvoDoAcesso {
  /** Operação (`abrir`, `ler_atendimento`, `historico`, `nota_listar`...). */
  readonly op: string;
  readonly patientId?: string;
  readonly targetId?: string;
}

/**
 * Executa a operação clínica. Perfil não clínico é negado ANTES de qualquer consulta (não descobre
 * nem se o atendimento existe). Toda negação de acesso clínico é gravada na trilha.
 */
export async function comNegacaoAuditada<T>(
  db: TenantDatabase,
  ctx: RequestContext,
  alvo: AlvoDoAcesso,
  operacao: () => Promise<T>,
): Promise<T> {
  try {
    if (!temPermissao(ctx.roles.filter(ehPerfil), 'conteudo_clinico:ler')) throw new ProibidoError('sem_vinculo_de_cuidado');
    return await operacao();
  } catch (e) {
    const motivo = motivoDe(e);
    if (motivo) {
      const metadata: AuditMetadata = {
        op: alvo.op,
        reason: motivo,
        ...(alvo.patientId ? { patient_id: alvo.patientId } : {}),
        ...(alvo.targetId ? { target_id: alvo.targetId } : {}),
      };
      await db.run(ctx.tenantId, (tx) => recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_ACESSO_NEGADO, metadata }), ctx.userId);
    }
    throw e;
  }
}
