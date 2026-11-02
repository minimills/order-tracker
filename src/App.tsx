import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import AgentPage from './pages/AgentPage'
import DashboardPage from './pages/DashboardPage'
import NotFoundPage from './pages/NotFoundPage'
import OrdersBoardPage from './pages/OrdersBoardPage'
import OrdersListPage from './pages/OrdersListPage'
import PaymentsPage from './pages/PaymentsPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="board" element={<OrdersBoardPage />} />
        <Route path="orders" element={<OrdersListPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="agent" element={<AgentPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
