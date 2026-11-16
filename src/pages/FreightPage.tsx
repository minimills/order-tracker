import { Link, useSearchParams } from 'react-router-dom'
import Can from '../components/Can'
import { secondaryButtonClass } from '../components/form'
import BreakdownList from '../components/freight/BreakdownList'
import FreightDashboard from '../components/freight/FreightDashboard'
import InsuranceSummary from '../components/freight/InsuranceSummary'
import { usePermissions } from '../lib/permissions'
import CratingReportPage from './CratingReportPage'

const TABS = [
  { key: 'dashboard', label: 'Dashboard', permission: 'freight.dashboard' },
  { key: 'breakdowns', label: 'Cost Breakdowns', permission: 'freight.breakdowns' },
  { key: 'insurance', label: 'Insurance Summary', permission: 'freight.insurance' },
  { key: 'crating', label: 'Crating Tables', permission: 'reports.crating' },
] as const

/** Freight: crating dashboard, shipment cost breakdowns, insurance summary and the crating tables. */
export default function FreightPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePermissions()
  const allowed = TABS.filter((t) => can(t.permission))
  const tab = allowed.find((t) => t.key === params.get('tab'))?.key ?? allowed[0]?.key

  return (
    <Can anyOf={['freight.dashboard', 'freight.breakdowns', 'freight.insurance', 'reports.crating', 'freight.quote']}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Freight</h1>
            <p className="text-sm text-slate-600">Crating, shipment cost breakdowns, freight quote requests and the insurance summary.</p>
          </div>
          <Can permission="freight.quote">
            <Link to="/freight/quote" className={secondaryButtonClass}>
              Freight Quote Request
            </Link>
          </Can>
        </div>

        {allowed.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist" aria-label="Freight">
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
