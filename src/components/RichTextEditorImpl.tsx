import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { cleanRichText, isEmptyRichText } from '../lib/richText'
import type { RichTextEditorProps } from './RichTextEditor'

const toolbarButton = (active: boolean) =>
  `min-w-9 rounded px-2 py-1 text-sm ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'} disabled:opacity-50`

/** The editor itself (loaded only when a note box is shown). */
/* @layout-helper */
export default function RichTextEditorImpl({ value, onChange, onBlur, disabled = false, placeholder, minHeight = '6rem', label, headings = false }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: headings ? { levels: [2, 3] } : false,
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
        strike: false,
        link: false,
        underline: false,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: cleanRichText(value),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: 'rich-text min-w-0 px-3 py-2 text-sm focus:outline-none',
        style: `min-height: ${minHeight}`,
        'aria-label': label ?? 'Notes',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML()
      onChange(isEmptyRichText(html) ? '' : cleanRichText(html))
    },
    onBlur: () => onBlur?.(),
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      bullet: e?.isActive('bulletList') ?? false,
      ordered: e?.isActive('orderedList') ?? false,
      task: e?.isActive('taskList') ?? false,
      h2: e?.isActive('heading', { level: 2 }) ?? false,
      h3: e?.isActive('heading', { level: 3 }) ?? false,
      empty: e?.isEmpty ?? true,
    }),
  })

  if (!editor) return null
  const run = (fn: () => void) => (ev: React.MouseEvent) => {
    ev.preventDefault()
    fn()
  }

  return (
    <div className={`rounded-md border border-slate-300 bg-white focus-within:border-slate-500 ${disabled ? 'bg-slate-50' : ''}`}>
      {!disabled && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 px-1 py-1" role="toolbar" aria-label="Formatting">
          <button type="button" title="Bold (Ctrl+B)" aria-pressed={state?.bold} className={`${toolbarButton(!!state?.bold)} font-bold`} onMouseDown={run(() => editor.chain().focus().toggleBold().run())}>
            B
          </button>
          <button type="button" title="Italic (Ctrl+I)" aria-pressed={state?.italic} className={`${toolbarButton(!!state?.italic)} italic`} onMouseDown={run(() => editor.chain().focus().toggleItalic().run())}>
            I
          </button>
          {headings && (
            <>
              <span className="mx-1 w-px bg-slate-200" aria-hidden="true" />
              <button type="button" title="Heading" aria-pressed={state?.h2} className={`${toolbarButton(!!state?.h2)} font-semibold`} onMouseDown={run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>
                Heading
              </button>
              <button type="button" title="Subheading" aria-pressed={state?.h3} className={toolbarButton(!!state?.h3)} onMouseDown={run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}>
                Subheading
              </button>
            </>
          )}
          <span className="mx-1 w-px bg-slate-200" aria-hidden="true" />
          <button type="button" title="Bullet list" aria-pressed={state?.bullet} className={toolbarButton(!!state?.bullet)} onMouseDown={run(() => editor.chain().focus().toggleBulletList().run())}>
            Bullets
          </button>
          <button type="button" title="Numbered list" aria-pressed={state?.ordered} className={toolbarButton(!!state?.ordered)} onMouseDown={run(() => editor.chain().focus().toggleOrderedList().run())}>
            Numbers
          </button>
          <button type="button" title="Checkbox list" aria-pressed={state?.task} className={toolbarButton(!!state?.task)} onMouseDown={run(() => editor.chain().focus().toggleTaskList().run())}>
            Checklist
          </button>
        </div>
      )}
      <div className="relative">
        {state?.empty && placeholder && (
          <div className="pointer-events-none absolute top-2 left-3 text-sm text-slate-400">{placeholder}</div>
        )}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
