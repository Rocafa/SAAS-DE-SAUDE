'use client';

/**
 * Portal do paciente: celular primeiro, 4 itens no menu, letra grande. Usa SÓ o contrato do portal
 * (ApiPortal, veto B3): nada da clínica no navegador do paciente. Sem Ajudante da equipe e sem
 * analytics com identificação (metricas-produto.md: superfície de paciente não leva user_hash).
 */
import { CalendarDays, FileText, ShieldCheck, UserRound, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AvisosProvider } from '@/components/app/desfazer';
import { PortalProvider, useOnlinePortal, usePortal, type AcoesDaFase, type FaseDoPortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, SemInternet, Vazio } from '@/components/ui/estados';
import { cn } from '@/lib/utils';

function Faixa({ fake }: { fake: boolean }) {
  return (
    <p className="border-b-2 border-borda bg-superficie-2 px-4 py-2 text-center text-[0.95rem] font-bold">
      Portal do paciente{fake ? ' · demonstração com dados fictícios' : ''}
    </p>
  );
}

function Estrutura({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const online = useOnlinePortal();
  const { vinculo, podeTrocar, trocar, modo } = usePortal();
  const responsavel = vinculo.agindoComo === 'responsavel_legal';
  const menu = [
    { rotulo: 'Consultas', rota: '/portal', icone: CalendarDays },
    { rotulo: 'Documentos', rota: '/portal/documentos', icone: FileText },
    { rotulo: responsavel ? 'Dados do paciente' : 'Meus dados', rota: '/portal/dados', icone: UserRound },
    { rotulo: responsavel ? 'Direitos do paciente' : 'Meus direitos', rota: '/portal/direitos', icone: ShieldCheck },
  ];
  return (
    <div className="min-h-dvh pb-28 md:pb-10">
      {!online && <SemInternet />}
      <Faixa fake={modo === 'fake'} />
      <header className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <p className="text-lg font-bold">{vinculo.clinica}</p>
        {podeTrocar && (
          <Botao variante="suave" tamanho="pequeno" onClick={trocar}>
            <Users aria-hidden />
            Trocar de pessoa
          </Botao>
        )}
      </header>
      {responsavel && (
        <p role="status" className="mx-auto mt-3 w-full max-w-3xl px-4">
          <span className="block rounded-md border-2 border-borda-forte p-3 font-bold">Você está agindo como responsável de {vinculo.primeiroNome}.</span>
        </p>
      )}
      <nav aria-label="Menu do portal" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t-2 border-borda-forte bg-fundo md:static md:mx-auto md:mt-4 md:flex md:max-w-3xl md:gap-2 md:border-0 md:px-4">
        {menu.map((m) => {
          const Icone = m.icone;
          const ativo = m.rota === '/portal' ? pathname === '/portal' : pathname.startsWith(m.rota);
          return (
            <Link
              key={m.rota}
              href={m.rota}
              aria-current={ativo ? 'page' : undefined}
              className={cn(
                'flex min-h-16 flex-col items-center justify-center gap-0.5 border-t-4 text-[0.8rem] leading-tight no-underline md:min-h-12 md:flex-row md:gap-2 md:rounded-md md:border-2 md:px-4 md:text-base',
                ativo ? 'border-borda-forte font-bold' : 'border-transparent md:border-borda',
              )}
            >
              <Icone aria-hidden className="size-6" />
              {m.rotulo}
            </Link>
          );
        })}
      </nav>
      <main id="conteudo" className="mx-auto w-full max-w-3xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/** Telas antes do vínculo estar pronto: carregando, escolha "de quem", sem vínculo, inativo, sessão vencida. */
function TelaDaFase({ f, acoes }: { f: Exclude<FaseDoPortal, { fase: 'pronto' }>; acoes: AcoesDaFase }) {
  switch (f.fase) {
    case 'carregando':
      return <Carregando />;
    case 'escolher':
      return (
        <>
          <h1 className="mb-1 text-[1.75rem] font-bold">De quem são os dados que você quer ver?</h1>
          <p className="mb-6 text-texto-suave">Você pode trocar depois, no alto da tela.</p>
          <ul className="flex flex-col gap-3">
            {f.vinculos.map((v) => (
              <li key={v.vinculoId}>
                <Botao variante="contorno" tamanho="grande" className="w-full justify-start text-left" onClick={() => acoes.escolher(v.vinculoId)}>
                  <UserRound aria-hidden />
                  <span>
                    <strong>{v.primeiroNome}</strong>
                    {v.agindoComo === 'responsavel_legal' ? ' · você é o responsável legal' : ' · você mesmo(a)'} · {v.clinica}
                  </span>
                </Botao>
              </li>
            ))}
          </ul>
        </>
      );
    case 'sem_vinculo':
      return (
        <Vazio
          titulo="Você ainda não tem acesso a nenhum cadastro"
          oQueFazer="Abra o link do convite que a clínica mandou para você. Se não recebeu, peça à clínica."
          acao={
            <Botao asChild>
              <Link href="/portal/convite">Tenho um código de convite</Link>
            </Botao>
          }
        />
      );
    case 'sem_sessao':
      return (
        <Vazio
          titulo="Sua sessão terminou"
          oQueFazer="Por segurança, entre de novo no portal."
          acao={
            <Botao asChild>
              <Link href="/portal/entrar">Entrar de novo</Link>
            </Botao>
          }
        />
      );
    case 'inativo':
      return <Vazio titulo="Acesso encerrado" oQueFazer={f.mensagem} />;
    case 'erro':
      return <Erro mensagem={f.mensagem} tentarDeNovo={acoes.tentarDeNovo} />;
  }
}

export default function LayoutPortal({ children }: { children: ReactNode }) {
  return (
    <PortalProvider
      telas={(f, acoes) => (
        <div className="min-h-dvh">
          <Faixa fake={false} />
          <main id="conteudo" className="mx-auto w-full max-w-3xl px-4 py-6">
            <TelaDaFase f={f} acoes={acoes} />
          </main>
        </div>
      )}
    >
      <AvisosProvider>
        <Estrutura>{children}</Estrutura>
      </AvisosProvider>
    </PortalProvider>
  );
}
