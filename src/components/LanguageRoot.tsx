import { Fragment, type ReactNode } from 'react'
import { useLanguage } from '../i18n'
import { usePreferences } from '../lib/preferences'

/**
 * Draws the whole app again when the language changes (no page reload), and
 * loads the signed-in person's preferences on every page, so the language
 * saved on their profile is used everywhere, also after a refresh.
 */
export default function LanguageRoot({ children }: { children: ReactNode }) {
  const lang = useLanguage()
  usePreferences()
  return <Fragment key={lang}>{children}</Fragment>
}
