import { lazy, Suspense } from 'react'

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
}

const Impl = lazy(() => import('./RichTextEditorImpl'))

/** A note box with Bold, Italic and bullet / numbered / checkbox lists. */
/* @layout-helper */
export default function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense fallback={<div className="h-24 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-400">Loading editor…</div>}>
      <Impl {...props} />
    </Suspense>
  )
}
