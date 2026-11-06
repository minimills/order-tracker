import { ACTION } from './wording'

/**
 * Opens the app's own confirmation box (Confirm / Cancel), drawn by
 * <ConfirmHost /> (mounted once in main.tsx), instead of the browser's
 * built-in boxes so it matches the rest of the app.
 *
 *   if (!(await confirmAction('Archive the board “My jobs”?'))) return
 *   const name = await askText('Template name', { initial: 'Shop floor' })  // null = cancelled
 */
export type Ask = {
  message: string
  confirmLabel: string
  danger: boolean
  /** When set, the box has a text field (askText). */
  input: { initial: string; label: string } | null
  resolve: (value: string | null) => void
}
let show: ((ask: Ask) => void) | null = null

/** Used by ConfirmHost to receive requests. */
export function registerConfirmHost(fn: ((ask: Ask) => void) | null) {
  show = fn
}

function open(ask: Omit<Ask, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null)
    show({ ...ask, resolve })
  })
}

/** Confirm / Cancel. Resolves true when confirmed. */
export async function confirmAction(message: string, options: { confirmLabel?: string; danger?: boolean } = {}) {
  const r = await open({ message, confirmLabel: options.confirmLabel ?? ACTION.confirm, danger: options.danger ?? false, input: null })
  return r !== null
}

/** A short text answer with Confirm / Cancel. Resolves the trimmed text, or null when cancelled or empty. */
export async function askText(message: string, options: { initial?: string; label?: string; confirmLabel?: string } = {}) {
  const r = await open({
    message,
    confirmLabel: options.confirmLabel ?? ACTION.confirm,
    danger: false,
    input: { initial: options.initial ?? '', label: options.label ?? message },
  })
  return r?.trim() ? r.trim() : null
}
