import { LANGUAGES, isLang, tr, useLanguage, type Lang } from '../i18n'
import { narrowInputClass } from './form'

/** The list of languages, each shown in its own language ("Français (Canada)"). */
/* @layout-helper */
export default function LanguagePicker({ id, onChange, value }: { id: string; onChange: (lang: Lang) => void; value?: Lang }) {
  const current = useLanguage()
  return (
    <select
      id={id}
      aria-label={tr('Language')}
      className={`${narrowInputClass} w-full max-w-xs`}
      value={value ?? current}
      onChange={(e) => isLang(e.target.value) && onChange(e.target.value)}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code} lang={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  )
}
