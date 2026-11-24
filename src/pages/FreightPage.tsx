import { Link, useSearchParams } from 'react-router-dom'
import Can from '../components/Can'
import { secondaryButtonClass } from '../components/form'
import BreakdownList from '../components/freight/BreakdownList'
import FreightDashboard from '../components/freight/FreightDashboard'
import InsuranceSummary from '../components/freight/InsuranceSummary'
import IncomingShipments from '../components/freight/IncomingShipments'
import ProfitLoss from '../components/freight/ProfitLoss'
import { usePermissions } from '../lib/permissions'
import { FREIGHT_KEYS } from '../lib/permissions/catalog'
import CratingReportPage from './CratingReportPage'
import PrintButton from '../components/print/PrintButton'
import { tr } from '../i18n'

const TABS = [
  { key: 'dashboard', get label() {
    return tr("Dashboard")
  }, permission: 'freight.dashboard' },
  { key: 'breakdowns', get label() {
    return tr("Cost Breakdowns")
  }, permission: 'freight.breakdowns' },
  { key: 'profit', get label() {
    return tr("Profit and Loss")
  }, permission: 'freight.profit' },
  { key: 'incoming', get label() {
    return tr("Incoming")
  }, permission: 'freight.incoming' },
  { key: 'insurance', get label() {
    return tr("Insurance Summary")
  }, permission: 'freight.insurance' },
  { key: 'crating', get label() {
    return tr("Crating Tables")
  }, permission: 'reports.crating' },
] as const

/** Freight: crating dashboard, shipment cost breakdowns, insurance summary and the crating tables. */
export default function FreightPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const allowed = TABS.filter((t) => can(t.permission))
  const tab = allowed.find((t) => t.key === params.get('tab'))?.key ?? allowed[0]?.key

  return (
    <Can anyOf={FREIGHT_KEYS}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold">{tr("Freight")}</h1>
              <Can permission="freight.print">
                <PrintButton title={tr("Freight")} />
              </Can>
            </div>
            <p className="text-sm text-slate-600">{tr("Crating, shipment cost breakdowns, profit and loss, incoming freight, freight quote requests and the insurance summary.")}</p>
          </div>
          <Can permission="freight.quote">
            <Link to="/freight/quote" className={secondaryButtonClass}>
              {tr("Freight Quote Request")}
            </Link>
          </Can>
        </div>

        {allowed.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label={tr("Freight")}>
            {allowed.map((t) => (
              <Can key={t.key} permission={t.permission}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${tab === t.key ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-600'}`}
                  onClick={() => setParams(t.key === allowed[0].key ? {} : { tab: t.key }, { replace: true })}
                >
                  {t.label}
                </button>
              </Can>
            ))}
          </div>
        )}

        {tab === 'dashboard' && (
          <Can permission="freight.dashboard">
            <FreightDashboard />
          </Can>
        )}
        {tab === 'breakdowns' && (
          <Can permission="freight.breakdowns">
            <BreakdownList />
          </Can>
        )}
        {tab === 'profit' && (
          <Can permission="freight.profit">
            <ProfitLoss />
          </Can>
        )}
        {tab === 'incoming' && (
          <Can permission="freight.incoming">
            <IncomingShipments />
          </Can>
        )}
        {tab === 'insurance' && (
          <Can permission="freight.insurance">
            <InsuranceSummary />
          </Can>
        )}
        {tab === 'crating' && (
          <Can permission="reports.crating">
            <CratingReportPage />
          </Can>
        )}
      </div>
    </Can>
  )
}
