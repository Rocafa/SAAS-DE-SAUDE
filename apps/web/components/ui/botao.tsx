'use client';

/**
 * Botão do design system (base shadcn/ui, tematizado em cinza). Alvo mínimo de 48 px.
 * Ícone nunca sozinho: o texto é obrigatório pelo tipo.
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const variantesBotao = cva(
  'inline-flex min-h-12 items-center justify-center gap-2 rounded-md px-5 font-bold leading-tight no-underline transition-[transform] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-6 [&_svg]:shrink-0',
  {
    variants: {
      variante: {
        principal: 'bg-principal text-principal-texto border-2 border-principal',
        contorno: 'bg-fundo text-texto border-2 border-borda-forte',
        suave: 'bg-superficie text-texto border-2 border-transparent hover:border-borda',
        perigo: 'bg-fundo text-texto border-[3px] border-dashed border-borda-forte',
      },
      tamanho: {
        normal: 'text-base',
        grande: 'min-h-16 px-7 text-lg',
        pequeno: 'min-h-12 px-4 text-[0.95rem]',
      },
    },
    defaultVariants: { variante: 'principal', tamanho: 'normal' },
  },
);

export interface BotaoProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variantesBotao> {
  asChild?: boolean;
  children: ReactNode;
}

export function Botao({ className, variante, tamanho, asChild, type, ...props }: BotaoProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(variantesBotao({ variante, tamanho }), className)}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}
