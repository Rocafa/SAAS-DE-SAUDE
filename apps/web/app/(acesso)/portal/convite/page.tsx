import type { Metadata } from 'next';
import { ResgateDoConvite } from '@/components/portal/resgate-convite';

/** Convite do paciente (P4). O token chega no `#fragmento` e nunca sai da página (sem Referer). */
export const metadata: Metadata = { title: 'Convite do portal', referrer: 'no-referrer' };

export default function PaginaConvite() {
  return <ResgateDoConvite />;
}
