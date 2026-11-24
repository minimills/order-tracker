import { Component, lazy, Suspense, type ReactNode } from 'react'
import { plainToHtml, richTextToPlain } from '../lib/richText'
import { loadRichTextEditor } from '../lib/richTextEditorLoader'
import { inputClass } from './form'
import { tr } from '../i18n'

export type RichTextEditorProps = {
  /** Saved note: HTML from the editor, or old plain text. */
  value: string | null | undefined
  /** Called with cleaned HTML ('' when empty) on every change. */
  onChange: (html: string) => void
  onBlur?: () => void
  disabled?: boolean
  placeholder?: string
  minHeight?: string
  label?: string
  /** Ctrl+Enter / Cmd+Enter (for example "send" in chat). */
  onSubmit?: () => void
  /** Gives the caller a small handle on the editor (chat mentions, clearing after sending). */
  onReady?: (api: EditorApi) => void
}

export type EditorApi = {
  /** Removes the last `remove` characters before the cursor and types `text` there. */
  replaceBeforeCursor: (remove: number, text: string) => void
  setContent: (html: string) => void
  focus: () => void
}

const Impl = lazy(loadRichTextEditor)

/**
 * Plain box used when the editor cannot load (for example a technician on
 * site without signal opening a page for the first time): the text is still
 * saved, as simple paragraphs.
 */
/* @layout-helper */
function PlainFallback({ value, onChange, onBlur, disabled, placeholder, label, minHeight }: RichTextEditorProps) {
  return (
    <div>
      <textarea
        aria-label={label ?? tr("Notes")}
        className={inputClass}
        style={{ minHeight: minHeight ?? '6rem' }}
        defaultValue={richTextToPlain(value)}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.trim() ? plainToHtml(e.target.value) : '')}
        onBlur={() => onBlur?.()}
      />
      <p className="mt-1 text-xs text-slate-500">{tr("Formatting is not available right now (the editor could not load). Your text is still saved.")}</p>
    </div>
  )
}

class EditorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * THE note box for every longer text (order notes, card descriptions and
 * comments, notices, notes, service notes, templates…): bold, italic,
 * underline, strikethrough, headings, bullet / numbered / checkbox lists and
 * links. Show the saved text with <RichText>.
 */
/* @layout-helper */
export default function RichTextEditor(props: RichTextEditorProps) {
  return (
    <EditorBoundary fallback={<PlainFallback {...props} />}>
      <Suspense fallback={<div className="h-24 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-400">{tr("Loading editor…")}</div>}>
        <Impl {...props} />
      </Suspense>
    </EditorBoundary>
  )
}
