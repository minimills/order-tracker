import { Link } from 'react-router-dom'
import { buttonClass } from '../components/form'

export default function OrdersListPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Orders list</h1>
        <Link to="/orders/new" className={buttonClass}>
          + New order
        </Link>
      </div>
      <p className="mt-2 text-slate-600">Every order, with search and filters.</p>
      <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
        The list is coming soon. For now, add an order with the New order button.
      </div>
    </div>
  )
}
