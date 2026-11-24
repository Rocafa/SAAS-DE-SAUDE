/**
 * Cliente SSM real das tarefas avulsas do provisionamento da clínica (B11) e da recuperação do fator do admin único (B12).
 * Pareceres: C4 de revisoes/2026-11-16-codigo-provisionamento-pr1.md, "SSM real" de
 * revisoes/2026-11-17-codigo-recuperacao-admin-unico.md e C2 de revisoes/2026-11-17-codigo-infra-ops-provisionamento.md.
 *
 * - `ler`: GetParameter com WithDecryption; parâmetro ausente vira `null`.
 * - `gravar`: PutParameter SecureString com a chave KMS PRÓPRIA do fluxo (`SSM_KMS_KEY_ID`, posta pelo Terraform na
 *   definição da tarefa), `Overwrite: false` e camada Advanced com política `Expiration` (72 h no provisionamento, 24 h
 *   na recuperação). Uma entrega anterior ainda no lugar NÃO é sobrescrita: vira `EntregaPendente` (código
 *   `entrega_pendente`), e o runbook manda quem entrega apagá-la sem ler.
 *   Custo (ESTIMATIVA, conferir na página de preços do AWS Systems Manager para sa-east-1): parâmetro Advanced custa da
 *   ordem de US$ 0,05 por mês, rateado pelas horas em que existe, mais US$ 0,05 por 10 mil chamadas de API. Um token
 *   vive no máximo 72 h, então cada execução fica abaixo de US$ 0,01.
 * - `apagar`: DeleteParameter (apaga também o histórico de versões); parâmetro ausente não é erro.
 *
 * Erro do SDK nunca sai: vira erro de mensagem fixa, sem `cause` (a mensagem do SDK pode citar o nome do parâmetro, e o
 * valor gravado é o token). Configuração falha fechada: sem `SSM_KMS_KEY_ID` válido, região fora de `sa-east-1` ou
 * variável que troque a credencial da tarefa, não há cliente (`ssm_nao_configurado`).
 */
import { DeleteParameterCommand, DescribeParametersCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { variaveisAwsProibidasPresentes } from '../modules/crypto/kms-client';

/** Validade da entrega por fluxo, em horas (igual à validade do token no banco: 0076 e 0077). */
export const VALIDADE_DA_ENTREGA_HORAS = { provisionamento: 72, recuperacao: 24, troca: 24 } as const;

/** Regiões aceitas (lista fechada): o pedido tem e-mail de pessoa e a entrega, o token. */
const REGIOES_SSM_PERMITIDAS: readonly string[] = ['sa-east-1'];
const AMBIENTES_LOCAIS: readonly string[] = ['development', 'test'];
/** ARN de chave (ou de alias) KMS na região permitida. O Terraform passa o ARN da chave do fluxo. */
const CHAVE_KMS = /^arn:aws:kms:sa-east-1:\d{12}:(key\/[0-9a-f-]{36}|alias\/[A-Za-z0-9/_-]+)$/;

/** A entrega de uma rodada anterior ainda está no SSM; nada foi sobrescrito. */
export class EntregaPendente extends Error {
  constructor() {
    super('entrega_pendente');
    this.name = 'EntregaPendente';
  }
}

/** Falha do SSM com mensagem fixa (nunca a do SDK). */
export class FalhaDoSsm extends Error {
  constructor(operacao: 'ler' | 'gravar' | 'apagar') {
    super(`ssm_falhou_${operacao}`);
    this.name = 'FalhaDoSsm';
  }
}

export type ComandoDoSsm = GetParameterCommand | PutParameterCommand | DeleteParameterCommand | DescribeParametersCommand;

/** O único método do `SSMClient` usado aqui; o teste injeta um dublê que confere a entrada de cada comando. */
export interface EnviaAoSsm {
  send(comando: ComandoDoSsm): Promise<unknown>;
}

export interface ParametrosSsm {
  readonly ler: (nome: string) => Promise<string | null>;
  readonly gravar: (nome: string, valor: string) => Promise<void>;
  readonly apagar: (nome: string) => Promise<void>;
  /**
   * Hora da gravação e vencimento (política `Expiration`) do parâmetro, sem ler o valor. `null` se ele não existe;
   * `venceEm` nulo se não há `Expiration`. Usada pela troca do admin (B13) para recusar pedido com vencimento longo.
   */
  readonly vencimento: (nome: string) => Promise<{ readonly gravadoEm: Date | null; readonly venceEm: Date | null } | null>;
}

export interface OpcoesDoCliente {
  readonly ssm: EnviaAoSsm;
  readonly chaveKms: string;
  readonly validadeHoras: number;
  readonly agora?: () => Date;
}

const nomeDoErro = (err: unknown): string | undefined => (typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined) as string | undefined;

export function criarParametrosSsm({ ssm, chaveKms, validadeHoras, agora = () => new Date() }: OpcoesDoCliente): ParametrosSsm {
  return {
    async ler(nome) {
      try {
        const r = (await ssm.send(new GetParameterCommand({ Name: nome, WithDecryption: true }))) as { Parameter?: { Value?: string } };
        const valor = r.Parameter?.Value;
        if (typeof valor !== 'string') throw new Error();
        return valor;
      } catch (err) {
        if (nomeDoErro(err) === 'ParameterNotFound') return null;
        throw new FalhaDoSsm('ler');
      }
    },
    async gravar(nome, valor) {
      const vence = new Date(agora().getTime() + validadeHoras * 3_600_000).toISOString();
      try {
        await ssm.send(
          new PutParameterCommand({
            Name: nome,
            Value: valor,
            Type: 'SecureString',
            KeyId: chaveKms,
            Overwrite: false,
            Tier: 'Advanced',
            Policies: JSON.stringify([{ Type: 'Expiration', Version: '1.0', Attributes: { Timestamp: vence } }]),
          }),
        );
      } catch (err) {
        if (nomeDoErro(err) === 'ParameterAlreadyExists') throw new EntregaPendente();
        throw new FalhaDoSsm('gravar');
      }
    },
    async apagar(nome) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: nome }));
      } catch (err) {
        if (nomeDoErro(err) === 'ParameterNotFound') return;
        throw new FalhaDoSsm('apagar');
      }
    },
    async vencimento(nome) {
      try {
        // DescribeParameters devolve as políticas e a data da gravação (GetParameter não devolve). Só metadados.
        const r = (await ssm.send(
          new DescribeParametersCommand({ ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: [nome] }], MaxResults: 1 }),
        )) as { Parameters?: { LastModifiedDate?: Date | string; Policies?: { PolicyType?: string; PolicyText?: string }[] }[] };
        const p = r.Parameters?.[0];
        if (!p) return null;
        const gravadoEm = p.LastModifiedDate ? new Date(p.LastModifiedDate) : null;
        let venceEm: Date | null = null;
        for (const pol of p.Policies ?? []) {
          if (pol.PolicyType !== 'Expiration' || typeof pol.PolicyText !== 'string') continue;
          const texto = JSON.parse(pol.PolicyText) as { Attributes?: { Timestamp?: unknown } };
          const t = typeof texto.Attributes?.Timestamp === 'string' ? Date.parse(texto.Attributes.Timestamp) : Number.NaN;
          if (Number.isFinite(t)) venceEm = new Date(t);
        }
        return { gravadoEm: gravadoEm && Number.isFinite(gravadoEm.getTime()) ? gravadoEm : null, venceEm };
      } catch {
        throw new FalhaDoSsm('ler');
      }
    },
  };
}

export interface ConfigDoSsm {
  readonly regiao: string;
  readonly chaveKms: string;
}

/**
 * Lê a configuração do cliente. `null` (falha fechada, `ssm_nao_configurado`) quando falta a chave KMS do fluxo, ela não
 * é um ARN da região permitida, a região não é `sa-east-1` ou, fora de development/test, há variável que trocaria a
 * credencial da tarefa ou desviaria o endpoint (a mesma lista da API, `VARIAVEIS_AWS_PROIBIDAS`).
 */
export function lerConfigDoSsm(env: NodeJS.ProcessEnv): ConfigDoSsm | null {
  const chaveKms = env.SSM_KMS_KEY_ID?.trim();
  const regiao = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim();
  if (!chaveKms || !CHAVE_KMS.test(chaveKms) || !regiao || !REGIOES_SSM_PERMITIDAS.includes(regiao)) return null;
  if (env.AWS_REGION && env.AWS_DEFAULT_REGION && env.AWS_REGION.trim() !== env.AWS_DEFAULT_REGION.trim()) return null;
  if (!AMBIENTES_LOCAIS.includes(env.NODE_ENV ?? '') && variaveisAwsProibidasPresentes(env).length > 0) return null;
  return { regiao, chaveKms };
}

/** Cliente real a partir do ambiente da tarefa (credencial: só o papel da tarefa, pela cadeia padrão do SDK). */
export function parametrosSsmDoAmbiente(env: NodeJS.ProcessEnv, validadeHoras: number): ParametrosSsm | null {
  const config = lerConfigDoSsm(env);
  if (!config) return null;
  const ssm = new SSMClient({ region: config.regiao, maxAttempts: 3 });
  return criarParametrosSsm({ ssm, chaveKms: config.chaveKms, validadeHoras });
}
