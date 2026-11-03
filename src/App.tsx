import { Navigate, Route, Routes } from 'react-router-dom'
import RequireAdmin from './components/admin/RequireAdmin'
import Layout from './components/Layout'
import RequireAuth from './components/RequireAuth'
import AgentPage from './pages/AgentPage'
import ActivityPage from './pages/admin/ActivityPage'
import AdminHomePage from './pages/admin/AdminHomePage'
import ArchivePage from './pages/admin/ArchivePage'
import BoardAdminPage from './pages/admin/BoardAdminPage'
import CompanyPage from './pages/admin/CompanyPage'
import OptionListsPage from './pages/admin/OptionListsPage'
import RecordsPage from './pages/admin/RecordsPage'
import SerialsPage from './pages/admin/SerialsPage'
import UsersPage from './pages/admin/UsersPage'
import AlertSettingsPage from './pages/AlertSettingsPage'
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
import ShopBoardPage from './pages/ShopBoardPage'

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      {/* Full-screen, printable shop board (no sidebar). */}
      <Route
        path="shop-board"
        element={
          <RequireAuth>
            <ShopBoardPage />
          </RequireAuth>
        }
      />
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
        {/* Old addresses of pages that moved to Admin */}
        <Route path="settings/machine-types" element={<Navigate to="/admin/machine-types" replace />} />
        <Route path="settings/alerts" element={<Navigate to="/admin/alerts" replace />} />
        {/* Admin area: admins only (the database enforces this too) */}
        <Route path="admin" element={<RequireAdmin />}>
          <Route index element={<AdminHomePage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="machine-types" element={<MachineTypesPage />} />
          <Route path="dropdowns" element={<OptionListsPage />} />
          <Route path="records" element={<RecordsPage />} />
          <Route path="serials" element={<SerialsPage />} />
          <Route path="board" element={<BoardAdminPage />} />
          <Route path="alerts" element={<AlertSettingsPage />} />
          <Route path="company" element={<CompanyPage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="activity" element={<ActivityPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
