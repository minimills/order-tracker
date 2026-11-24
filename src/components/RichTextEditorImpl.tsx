import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { askText } from '../lib/confirm'
import { cleanRichText, isEmptyRichText, safeLink } from '../lib/richText'
import type { RichTextEditorProps } from './RichTextEditor'
import { tr } from '../i18n'

const toolbarButton = (active: boolean) =>
  `min-w-8 rounded px-2 py-1 text-sm ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'} disabled:opacity-50`

/**
 * THE editor for every longer piece of text in the app (loaded only when a
 * note box is shown): bold, italic, underline, strikethrough, headings,
 * bullet / numbered / checkbox lists and links. Everything it gives back is
 * cleaned by cleanRichText (src/lib/richText.ts).
 */
/* @layout-helper */
export default function RichTextEditorImpl({ value, onChange, onBlur, disabled = false, placeholder, minHeight = '6rem', label, onSubmit, onReady }: RichTextEditorProps) {
  // The latest "send" action (the editor is made once, so it reads it through a ref).
  const submitRef = useRef(onSubmit)
  const changeRef = useRef(onChange)
  const blurRef = useRef(onBlur)
  useEffect(() => {
    submitRef.current = onSubmit
    changeRef.current = onChange
    blurRef.current = onBlur
  }, [onSubmit, onChange, onBlur])
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto', 'tel'],
          isAllowedUri: (url) => safeLink(url) !== null,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
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
      handleKeyDown: (_view, event) => {
        if (submitRef.current && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          submitRef.current()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML()
      changeRef.current(isEmptyRichText(html) ? '' : cleanRichText(html))
    },
    onBlur: () => blurRef.current?.(),
  })

  useEffect(() => {
    if (!editor || !onReady) return
    onReady({
      replaceBeforeCursor: (remove, text) => {
        const to = editor.state.selection.from
        editor.chain().focus().deleteRange({ from: Math.max(1, to - remove), to }).insertContent(text).run()
      },
      setContent: (html) => editor.commands.setContent(cleanRichText(html)),
      focus: () => editor.commands.focus('end'),
    })
  }, [editor, onReady])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold') ?? false,
      italic: e?.isActive('italic') ?? false,
      underline: e?.isActive('underline') ?? false,
      strike: e?.isActive('strike') ?? false,
      link: e?.isActive('link') ?? false,
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
  const editLink = async () => {
    const current = (editor.getAttributes('link').href as string | undefined) ?? ''
    const typed = await askText(tr("Link address (leave empty to remove the link)"), { initial: current, get label() {
    return tr("Link address")
  }, confirmLabel: current ? tr("Save Changes") : tr("Add Link") })
    const chain = editor.chain().focus().extendMarkRange('link')
    if (!typed) {
      chain.unsetLink().run()
      return
    }
    const href = safeLink(/^[a-z]+:/i.test(typed) || typed.startsWith('#') ? typed : typed.includes('@') && !typed.includes('/') ? `mailto:${typed}` : `https://${typed}`)
    if (!href) return
    if (editor.state.selection.empty && !current) chain.insertContent({ type: 'text', text: typed, marks: [{ type: 'link', attrs: { href } }] }).run()
    else chain.setLink({ href }).run()
  }
  const sep = <span className="mx-0.5 w-px self-stretch bg-slate-200" aria-hidden="true" />

  return (
    <div className={`rounded-md border border-slate-300 bg-white focus-within:border-slate-500 ${disabled ? 'bg-slate-50' : ''}`}>
      {!disabled && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 px-1 py-1" role="toolbar" aria-label={tr("Formatting")}>
          <button type="button" title={tr("Bold (Ctrl+B)")} aria-label={tr("Bold")} aria-pressed={state?.bold} className={`${toolbarButton(!!state?.bold)} font-bold`} onMouseDown={run(() => editor.chain().focus().toggleBold().run())}>
            B
          </button>
          <button type="button" title={tr("Italic (Ctrl+I)")} aria-label={tr("Italic")} aria-pressed={state?.italic} className={`${toolbarButton(!!state?.italic)} italic`} onMouseDown={run(() => editor.chain().focus().toggleItalic().run())}>
            I
          </button>
          <button type="button" title={tr("Underline (Ctrl+U)")} aria-label={tr("Underline")} aria-pressed={state?.underline} className={`${toolbarButton(!!state?.underline)} underline`} onMouseDown={run(() => editor.chain().focus().toggleUnderline().run())}>
            U
          </button>
          <button type="button" title={tr("Strikethrough (Ctrl+Shift+S)")} aria-label={tr("Strikethrough")} aria-pressed={state?.strike} className={`${toolbarButton(!!state?.strike)} line-through`} onMouseDown={run(() => editor.chain().focus().toggleStrike().run())}>
            S
          </button>
          {sep}
          <button type="button" title={tr("Heading")} aria-pressed={state?.h2} className={`${toolbarButton(!!state?.h2)} font-semibold`} onMouseDown={run(() => editor.chain().focus().toggleHeading({ level: 2 }).run())}>
            {tr("Heading")}
          </button>
          <button type="button" title={tr("Subheading")} aria-pressed={state?.h3} className={toolbarButton(!!state?.h3)} onMouseDown={run(() => editor.chain().focus().toggleHeading({ level: 3 }).run())}>
            {tr("Subheading")}
          </button>
          {sep}
          <button type="button" title={tr("Bullet list")} aria-pressed={state?.bullet} className={toolbarButton(!!state?.bullet)} onMouseDown={run(() => editor.chain().focus().toggleBulletList().run())}>
            {tr("Bullets")}
          </button>
          <button type="button" title={tr("Numbered list")} aria-pressed={state?.ordered} className={toolbarButton(!!state?.ordered)} onMouseDown={run(() => editor.chain().focus().toggleOrderedList().run())}>
            {tr("Numbers")}
          </button>
          <button type="button" title={tr("Checkbox list")} aria-pressed={state?.task} className={toolbarButton(!!state?.task)} onMouseDown={run(() => editor.chain().focus().toggleTaskList().run())}>
            {tr("Checklist")}
          </button>
          {sep}
          <button type="button" title={tr("Add or change a link")} aria-pressed={state?.link} className={toolbarButton(!!state?.link)} onMouseDown={run(() => void editLink())}>
            {tr("Link")}
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
