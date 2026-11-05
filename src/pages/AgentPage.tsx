import Can from '../components/Can'
import PlaceholderPage from '../components/PlaceholderPage'

export default function AgentPage() {
  return (
    <Can permission="agent">
      <PlaceholderPage title="Agent" description="Ask questions about your orders in plain words." />
    </Can>
  )
}
