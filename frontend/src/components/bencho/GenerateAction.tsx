// Adapted from Bencho's Generate block, MIT, Copyright (c) 2026 Lorenzo Cabra.
// Source and original files: third-party/bencho/README.md.
import { Button, type ButtonProps } from '@/components/base/buttons/button';
import { RiLoader4Line } from '@remixicon/react';

export function GenerateAction({ busy, className, disabled, ...props }: Omit<ButtonProps, 'children'> & { busy: boolean }) {
  return <Button {...props} variant="secondary" className={[className, busy && 'ai-action-busy'].filter(Boolean).join(' ')} leadingIcon={busy ? RiLoader4Line : undefined}
    aria-busy={busy} disabled={disabled || busy}>
    <span>{busy ? '运行中…' : '运行'}</span>
  </Button>;
}
