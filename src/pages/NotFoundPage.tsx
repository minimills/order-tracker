import PlaceholderPage from '../components/PlaceholderPage'
import { tr } from '../i18n'

export default function NotFoundPage() {
  return <PlaceholderPage title={tr("Page Not Found")} description={tr("That page does not exist. Use the menu to choose a page.")} />
}
