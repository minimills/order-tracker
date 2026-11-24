import Can from '../components/Can'
import PlaceholderPage from '../components/PlaceholderPage'
import { tr } from '../i18n'

export default function AgentPage() {
  return (
    <Can permission="agent">
      <PlaceholderPage title={tr("Agent")} description={tr("Ask questions about your orders in plain language.")} />
    </Can>
  )
}
