import { cleanRichText } from '../lib/richText'

/** Shows a note with its formatting (safely cleaned). */
/* @layout-helper */
export default function RichText({ value, className = '' }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className="text-slate-400">—</span>
  // cleanRichText keeps only bold, italic, lists and checkboxes (no scripts, links or styles).
  return <div className={`rich-text rich-text-readonly ${className}`} dangerouslySetInnerHTML={{ __html: cleanRichText(value) }} />
}
