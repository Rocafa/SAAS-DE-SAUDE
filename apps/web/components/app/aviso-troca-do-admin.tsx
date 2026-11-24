'use client';

/**
 * Aviso fixo da troca do admin único (B13; desenho docs/04-arquitetura/troca-do-admin-unico.md, seções 5 e 7).
 *
 * Aparece SÓ para a conta antiga (o admin a ser substituído), na clínica da troca, enquanto a troca está em andamento:
 * quem decide é a API (`GET /sessao/troca-do-admin`). Não tem botão de fechar: some quando a troca termina ou é
 * contestada. Minimização: mostra só que a troca foi pedida, quando a janela termina e se está parada; nada do e-mail
 * novo nem de quem pediu. O botão "Não fui eu" pede confirmação antes de chamar a contestação (a API exige MFA recente).
 */
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Botao } from '@/components/ui/botao';
import { textoDoErro } from '@/components/app/desfazer';
import { ErroApi } from '@/lib/api/http';
import type { TrocaDoAdminEmJanela } from '@/lib/api/tipos';
import { useDados } from './dados';

export type EtapaDoAviso = 'aviso' | 'confirmar' | 'enviando' | 'contestada';

const FORMATO = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** "26/11/2026 às 12:00" no horário de Brasília. */
export function dataDoFimDaJanela(liberaEm: string): string {
  const partes = Object.fromEntries(FORMATO.formatToParts(new Date(liberaEm)).map((p) => [p.type, p.value]));
  return `${partes['day']}/${partes['month']}/${partes['year']} às ${partes['hour']}:${partes['minute']}`;
}

/** Frase do fim da janela; depois dela, o "não fui eu" ainda vale até a conclusão. */
export function textoDaJanela(troca: TrocaDoAdminEmJanela, agora: Date): string {
  const data = dataDoFimDaJanela(troca.liberaEm);
  if (troca.suspensa) return `O pedido está parado até a revisão da equipe de segurança. A janela de espera vai até ${data} (horário de Brasília).`;
  if (new Date(troca.liberaEm).getTime() > agora.getTime()) {
    return `A janela de espera termina em ${data} (horário de Brasília). Depois disso, a troca pode ser concluída.`;
  }
  return `A janela de espera terminou em ${data} (horário de Brasília), mas a troca ainda não foi concluída.`;
}

export interface AvisoTrocaDoAdminVisaoProps {
  troca: TrocaDoAdminEmJanela;
  agora: Date;
  etapa: EtapaDoAviso;
  erro?: string | undefined;
  aoNaoFuiEu?: () => void;
  aoConfirmar?: () => void;
  aoVoltar?: () => void;
}

/** Só a apresentação (testada sem navegador). */
export function AvisoTrocaDoAdminVisao({ troca, agora, etapa, erro, aoNaoFuiEu, aoConfirmar, aoVoltar }: AvisoTrocaDoAdminVisaoProps) {
  return (
    <section
      role="alert"
      aria-labelledby="aviso-troca-do-admin-titulo"
      data-testid="aviso-troca-do-admin"
      className="border-b-4 border-borda-forte bg-superficie-2 px-4 py-4 md:px-8"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3">
        <h2 id="aviso-troca-do-admin-titulo" className="flex items-center gap-2 text-lg font-bold">
          <ShieldAlert aria-hidden className="size-6 shrink-0" />
          Foi pedida a troca do administrador desta clínica
        </h2>
        {etapa === 'contestada' ? (
          <p className="font-bold">
            Pronto: você contestou o pedido e a troca parou. A equipe de segurança vai falar com o contato do contrato da clínica.
          </p>
        ) : (
          <>
            <p>
              Pediram ao suporte que esta conta deixe de ser a administradora da clínica. {textoDaJanela(troca, agora)}
            </p>
            {etapa === 'aviso' && (
              <>
                <p>Se não foi você nem alguém autorizado pela clínica, avise agora.</p>
                <div>
                  <Botao variante="contorno" onClick={aoNaoFuiEu}>
                    Não fui eu
                  </Botao>
                </div>
              </>
            )}
            {(etapa === 'confirmar' || etapa === 'enviando') && (
              <>
                <p className="font-bold">
                  Confirma que você não pediu essa troca? Ela será contestada e parada, e a equipe de segurança vai investigar.
                </p>
                <div className="flex flex-wrap gap-3">
                  <Botao onClick={aoConfirmar} disabled={etapa === 'enviando'} data-testid="confirmar-nao-fui-eu">
                    {etapa === 'enviando' ? 'Enviando…' : 'Sim, não fui eu'}
                  </Botao>
                  <Botao variante="suave" onClick={aoVoltar} disabled={etapa === 'enviando'}>
                    Voltar
                  </Botao>
                </div>
              </>
            )}
          </>
        )}
        {erro && (
          <p role="alert" className="font-bold">
            ⚠ {erro}
          </p>
        )}
      </div>
    </section>
  );
}

/** O aviso ligado à camada de dados: pergunta à API a cada sessão (e a cada `atualizar()`). */
export function AvisoTrocaDoAdmin() {
  const { api, usuario, versao } = useDados();
  const [troca, setTroca] = useState<TrocaDoAdminEmJanela | null>(null);
  const [etapa, setEtapa] = useState<EtapaDoAviso>('aviso');
  const [erro, setErro] = useState<string>();

  useEffect(() => {
    let vivo = true;
    if (!usuario) {
      setTroca(null);
      return;
    }
    api
      .trocaDoAdminEmJanela()
      .then((t) => vivo && setTroca(t))
      // Sem resposta, não há o que mostrar; a próxima carga pergunta de novo.
      .catch(() => vivo && setTroca(null));
    return () => {
      vivo = false;
    };
  }, [api, usuario, versao]);

  if (!troca) return null;

  async function confirmar() {
    setEtapa('enviando');
    setErro(undefined);
    try {
      await api.contestarTrocaDoAdmin();
      setEtapa('contestada');
    } catch (e) {
      if (e instanceof ErroApi && e.status === 404) {
        // A troca já terminou (concluída, cancelada ou contestada por outra aba).
        setTroca(null);
        return;
      }
      setErro(textoDoErro(e, 'Não deu certo. Tente de novo.'));
      setEtapa('confirmar');
    }
  }

  return (
    <AvisoTrocaDoAdminVisao
      troca={troca}
      agora={new Date()}
      etapa={etapa}
      erro={erro}
      aoNaoFuiEu={() => {
        setErro(undefined);
        setEtapa('confirmar');
      }}
      aoConfirmar={() => void confirmar()}
      aoVoltar={() => {
        setErro(undefined);
        setEtapa('aviso');
      }}
    />
  );
}
