import type { ButtonHTMLAttributes } from 'react'
import { cx } from '../../lib/cx'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'lg' | 'md' | 'sm'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-foreground text-background hover:bg-foreground/90',
  secondary:
    'border border-foreground/20 bg-card text-foreground hover:border-foreground hover:bg-foreground/5',
  ghost: 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground',
}

const SIZES: Record<Size, string> = {
  lg: 'h-14 gap-3 px-8 text-base',
  md: 'h-10 gap-2 px-5 text-sm',
  sm: 'h-8 gap-1.5 px-3 text-xs',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({ variant = 'secondary', size = 'md', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-medium transition-colors duration-300 disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  )
}
