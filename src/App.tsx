import { Route, Routes, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import HomeRedirect from './components/HomeRedirect'
import Page from './components/Page'
import RequireAuth from './components/RequireAuth'
import { ADMIN_KEYS } from './lib/permissions/catalog'
import ActivityPage from './pages/admin/ActivityPage'
import AdminHomePage from './pages/admin/AdminHomePage'
import ArchivePage from './pages/admin/ArchivePage'
import ChecklistTemplatesPage from './pages/admin/ChecklistTemplatesPage'
import BuildChecklistsPage from './pages/admin/BuildChecklistsPage'
import ProductionPage from './pages/admin/ProductionPage'
import BuildTimesPage from './pages/BuildTimesPage'
import ServicePage from './pages/ServicePage'
import ChatPage from './pages/ChatPage'
import NoticeBoardPage from './pages/NoticeBoardPage'
import NoticePrintPage from './pages/NoticePrintPage'
import HolidaysPage from './pages/admin/HolidaysPage'
import ChatChannelsPage from './pages/admin/ChatChannelsPage'
import CalendarPage from './pages/CalendarPage'
import ServiceOrderPage from './pages/ServiceOrderPage'
import CertificatePage from './pages/CertificatePage'
import TemplatesPage from './pages/admin/TemplatesPage'
import CeAdminPage from './pages/admin/CeAdminPage'
import BoardAdminPage from './pages/admin/BoardAdminPage'
import CompanyPage from './pages/admin/CompanyPage'
import DepartmentsPage from './pages/admin/DepartmentsPage'
import ImportPage from './pages/admin/ImportPage'
import OptionListsPage from './pages/admin/OptionListsPage'
import BoardTemplatesPage from './pages/admin/BoardTemplatesPage'
import EmailLogPage from './pages/admin/EmailLogPage'
import EmailPage from './pages/admin/EmailPage'
import GroupsPage from './pages/admin/GroupsPage'
import OrderDefaultsPage from './pages/admin/OrderDefaultsPage'
import SchedulingPage from './pages/admin/SchedulingPage'
import RecordsPage from './pages/admin/RecordsPage'
import SerialsPage from './pages/admin/SerialsPage'
import StagesPage from './pages/admin/StagesPage'
import UsersPage from './pages/admin/UsersPage'
import AgentPage from './pages/AgentPage'
import AlertSettingsPage from './pages/AlertSettingsPage'
import ChecklistPage from './pages/ChecklistPage'
import ChecklistPrintPage from './pages/ChecklistPrintPage'
import BoardPage from './pages/BoardPage'
import BoardsPage from './pages/BoardsPage'
import DepartmentDelaysPage from './pages/DepartmentDelaysPage'
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
import MachinePage from './pages/MachinePage'
import NotificationSettingsPage from './pages/NotificationSettingsPage'
import StatusPage from './pages/admin/StatusPage'
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
      {/* Printable signed final check (no sidebar). */}
      <Route
        path="checklists/:machineId/print"
        element={
          <RequireAuth>
            <Page permission="checklist.print">
              <ChecklistPrintPage />
            </Page>
          </RequireAuth>
        }
      />
      {/* A notice laid out for printing (no sidebar). */}
      <Route
        path="notices/:id/print"
        element={
          <RequireAuth>
            <Page permission="notices.print">
              <NoticePrintPage />
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
        <Route path="machines" element={<Page permission="machines"><MachinePage /></Page>} />
        <Route path="machines/:id" element={<Page permission="machines"><MachinePage /></Page>} />
        <Route path="payments" element={<Page permission="payments.page"><PaymentsPage /></Page>} />
        <Route path="checklists/:machineId" element={<Page permission="checklist"><ChecklistPage /></Page>} />
        <Route path="crating" element={<Page permission="reports.crating"><CratingReportPage /></Page>} />
        <Route path="boards" element={<Page permission="boards"><BoardsPage /></Page>} />
        <Route path="notices" element={<Page permission="notices"><NoticeBoardPage /></Page>} />
        <Route path="chat" element={<Page permission="chat"><ChatPage /></Page>} />
        <Route path="chat/:conversationId" element={<Page permission="chat"><ChatPage /></Page>} />
        <Route path="service" element={<Page permission="service"><ServicePage /></Page>} />
        <Route path="service/certificates/:id" element={<Page permission="service.certificate"><CertificatePage /></Page>} />
        <Route path="service/calendar" element={<Page permission="service.calendar"><CalendarPage /></Page>} />
        <Route path="service/calls/:callId" element={<Page permission="service.calls"><ServiceOrderPage kind="call" /></Page>} />
        <Route path="service/:orderId" element={<Page permission="service"><ServiceOrderPage /></Page>} />
        <Route path="boards/:id" element={<Page permission="boards"><BoardPage /></Page>} />
        <Route path="reports/department-delays" element={<Page permission="reports.department_delays"><DepartmentDelaysPage /></Page>} />
        <Route path="reports/build-times" element={<Page permission="reports.build_times"><BuildTimesPage /></Page>} />
        <Route path="agent" element={<Page permission="agent"><AgentPage /></Page>} />
        <Route path="settings" element={<Page permission="settings"><SettingsPage /></Page>} />
        <Route path="settings/notifications" element={<Page permission="settings.notification_channels"><NotificationSettingsPage /></Page>} />
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
          <Route path="stages" element={<Page permission="admin.stages" level="edit"><StagesPage /></Page>} />
          <Route path="order-defaults" element={<Page permission="admin.order_defaults" level="edit"><OrderDefaultsPage /></Page>} />
          <Route path="email" element={<Page permission="admin.email" level="edit"><EmailPage /></Page>} />
          <Route path="email-log" element={<Page permission="admin.email_log"><EmailLogPage /></Page>} />
          <Route path="groups" element={<Page permission="admin.groups" level="edit"><GroupsPage /></Page>} />
          <Route path="board-templates" element={<Page permission="admin.board_templates" level="edit"><BoardTemplatesPage /></Page>} />
          <Route path="holidays" element={<Page permission="admin.holidays" level="edit"><HolidaysPage /></Page>} />
          <Route path="scheduling" element={<Page permission="admin.scheduling" level="edit"><SchedulingPage /></Page>} />
          <Route path="checklists" element={<Page permission="admin.checklists" level="edit"><ChecklistTemplatesPage /></Page>} />
          <Route path="chat" element={<Page permission="admin.chat" level="edit"><ChatChannelsPage /></Page>} />
          <Route path="templates" element={<Page permission="admin.templates" level="edit"><TemplatesPage /></Page>} />
          <Route path="ce" element={<Page permission="admin.ce" level="edit"><CeAdminPage /></Page>} />
          <Route path="build-checklists" element={<Page permission="admin.build_checklists" level="edit"><BuildChecklistsPage /></Page>} />
          <Route path="production" element={<Page permission="admin.production" level="edit"><ProductionPage /></Page>} />
          <Route path="records" element={<Page permission="admin.records" level="edit"><RecordsPage /></Page>} />
          <Route path="serials" element={<Page permission="admin.serials" level="edit"><SerialsPage /></Page>} />
          <Route path="board" element={<Page permission="admin.board" level="edit"><BoardAdminPage /></Page>} />
          <Route path="alerts" element={<Page permission="admin.alerts" level="edit"><AlertSettingsPage /></Page>} />
          <Route path="company" element={<Page permission="admin.company" level="edit"><CompanyPage /></Page>} />
          <Route path="archive" element={<Page permission="admin.archive" level="edit"><ArchivePage /></Page>} />
          <Route path="status" element={<Page permission="admin.status" level="edit"><StatusPage /></Page>} />
          <Route path="activity" element={<Page permission="admin.activity"><ActivityPage /></Page>} />
          <Route path="import" element={<Page permission="admin.import" level="edit"><ImportPage /></Page>} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
