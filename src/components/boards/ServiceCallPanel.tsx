// @permission-scope boards.card.open
import { Link } from 'react-router-dom'
import Can from '../Can'
import SerialNumber from '../SerialNumber'
import { countryFlag } from '../../lib/country'
import { serviceDates, type ServiceCallInfo } from '../../lib/service'

/** In the card window of the Service Calls board: the call's details and a link to its service log. */
export default function ServiceCallPanel({ call }: { call: ServiceCallInfo | null }) {
  return (
    <Can permission="service.calls">
      {call ? (
        <div className="space-y-1 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm">
          <p className="font-semibold">
            Service call {call.call_code}
            {call.customer_name ? ` · ${call.customer_name}` : ''}
            {call.customer_country ? ` · ${countryFlag(call.customer_country)} ${call.customer_country}` : ''}
          </p>
          <p className="text-slate-700">
            {[call.technician_name ?? 'No technician', serviceDates(call.planned_start, call.planned_end) || 'dates not set'].join(' · ')}
          </p>
          {call.machines.length > 0 && (
            <ul className="flex flex-wrap gap-x-3">
              {call.machines.map((m) => (
                <li key={m.machine_id}>
                  {m.machine} {m.serial && <SerialNumber serial={m.serial} className="text-xs" />}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-600">
            {call.entries ? `${call.entries} day${call.entries === 1 ? '' : 's'} logged` : 'No days logged yet'}
            {call.report_status === 'signed' ? ' · service report signed' : call.report_status === 'draft' ? ' · service report in draft' : ''}
          </p>
          <Can permission="service">
            <Link to={`/service/calls/${call.card_id}`} className="font-medium text-blue-700 underline">
              Open the Service Call (customer, machines, day log, report)
            </Link>
          </Can>
        </div>
      ) : (
        <p className="text-sm text-slate-500">Loading the service call…</p>
      )}
    </Can>
  )
}
