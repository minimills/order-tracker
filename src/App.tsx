import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import AgentPage from './pages/AgentPage'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import MachineTypesPage from './pages/MachineTypesPage'
import NewOrderPage from './pages/NewOrderPage'
import NotFoundPage from './pages/NotFoundPage'
import OrdersBoardPage from './pages/OrdersBoardPage'
import OrderPage from './pages/OrderPage'
import OrdersListPage from './pages/OrdersListPage'
import PaymentsPage from './pages/PaymentsPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="board" element={<OrdersBoardPage />} />
        <Route path="orders" element={<OrdersListPage />} />
        <Route path="orders/new" element={<NewOrderPage />} />
        <Route path="orders/:id" element={<OrderPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="agent" element={<AgentPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/machine-types" element={<MachineTypesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
