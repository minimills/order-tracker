import { Route, Routes, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import HomeRedirect from './components/HomeRedirect'
import Page from './components/Page'
import RequireAuth from './components/RequireAuth'
import { ADMIN_KEYS } from './lib/permissions/catalog'
import ActivityPage from './pages/admin/ActivityPage'
import AdminHomePage from './pages/admin/AdminHomePage'
import ArchivePage from './pages/admin/ArchivePage'
import BoardAdminPage from './pages/admin/BoardAdminPage'
import CompanyPage from './pages/admin/CompanyPage'
import DepartmentsPage from './pages/admin/DepartmentsPage'
import ImportPage from './pages/admin/ImportPage'
import OptionListsPage from './pages/admin/OptionListsPage'
import RecordsPage from './pages/admin/RecordsPage'
import SerialsPage from './pages/admin/SerialsPage'
import UsersPage from './pages/admin/UsersPage'
import AgentPage from './pages/AgentPage'
import AlertSettingsPage from './pages/AlertSettingsPage'
import CratingReportPage from './pages/CratingReportPage'
import DashboardPage from './pages/DashboardPage'
import LoginPage from './pages/LoginPage'
import MachineTypesPage from './pages/MachineTypesPage'
import NewOrderPage from './pages/NewOrderPage'
import NotFoundPage from './pages/NotFoundPage'
import OrderPage from './pages/OrderPage'
import OrdersBoardPage from './pages/OrdersBoardPage'
import OrdersListPage from './pages/OrdersListPage'
import PaymentsPage from './pages/PaymentsPage'
import SettingsPage from './pages/SettingsPage'
import ShopBoardPage from './pages/ShopBoardPage'

/** Every page sits in <Page permission="…">; see src/lib/permissions/catalog.ts. */
export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      {/* Full-screen, printable shop board (no sidebar). */}
      <Route
        path="shop-board"
        element={
          <RequireAuth>
            <Page permission="shop_board">
              <ShopBoardPage />
            </Page>
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
        <Route index element={<HomeRedirect />} />
        <Route path="dashboard" element={<Page permission="dashboard"><DashboardPage /></Page>} />
        <Route path="board" element={<Page permission="orders.board"><OrdersBoardPage /></Page>} />
        <Route path="orders" element={<Page permission="orders.list"><OrdersListPage /></Page>} />
        <Route path="orders/new" element={<Page permission="orders.new" level="edit"><NewOrderPage /></Page>} />
        <Route path="orders/:id" element={<Page permission="order.page"><OrderPage /></Page>} />
        <Route path="payments" element={<Page permission="payments.page"><PaymentsPage /></Page>} />
        <Route path="crating" element={<Page permission="reports.crating"><CratingReportPage /></Page>} />
        <Route path="agent" element={<Page permission="agent"><AgentPage /></Page>} />
        <Route path="settings" element={<Page permission="settings"><SettingsPage /></Page>} />
        {/* Old addresses of pages that moved to Admin */}
        <Route path="settings/machine-types" element={<Navigate to="/admin/machine-types" replace />} />
        <Route path="settings/alerts" element={<Navigate to="/admin/alerts" replace />} />
        {/* Admin area: full admins, or people given that admin page (the database checks this too) */}
        <Route path="admin">
          <Route index element={<Page anyOf={ADMIN_KEYS}><AdminHomePage /></Page>} />
          <Route path="users" element={<Page permission="admin.users" level="edit"><UsersPage /></Page>} />
          <Route path="departments" element={<Page permission="admin.departments" level="edit"><DepartmentsPage /></Page>} />
          <Route path="machine-types" element={<Page permission="admin.machine_types" level="edit"><MachineTypesPage /></Page>} />
          <Route path="dropdowns" element={<Page permission="admin.dropdowns" level="edit"><OptionListsPage /></Page>} />
          <Route path="records" element={<Page permission="admin.records" level="edit"><RecordsPage /></Page>} />
          <Route path="serials" element={<Page permission="admin.serials" level="edit"><SerialsPage /></Page>} />
          <Route path="board" element={<Page permission="admin.board" level="edit"><BoardAdminPage /></Page>} />
          <Route path="alerts" element={<Page permission="admin.alerts" level="edit"><AlertSettingsPage /></Page>} />
          <Route path="company" element={<Page permission="admin.company" level="edit"><CompanyPage /></Page>} />
          <Route path="archive" element={<Page permission="admin.archive" level="edit"><ArchivePage /></Page>} />
          <Route path="activity" element={<Page permission="admin.activity"><ActivityPage /></Page>} />
          <Route path="import" element={<Page permission="admin.import" level="edit"><ImportPage /></Page>} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
