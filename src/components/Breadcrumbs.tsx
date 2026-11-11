import { Fragment } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { crumbsForPath, usePageCrumbs } from '../lib/breadcrumbs'
import Icon from './Icon'

/** "Orders > Order 86 > Carder - Large LCR-2073" at the top of every page; each earlier part is a link. */
export default function Breadcrumbs() {
  const { pathname } = useLocation()
  const fromPage = usePageCrumbs()
  const crumbs = fromPage ?? crumbsForPath(pathname)
  if (crumbs.length === 0) return null
  return (
    <nav aria-label="Breadcrumb" className="mb-3 min-w-0 text-sm print:hidden">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-slate-500">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 && (
                <li aria-hidden="true" className="flex items-center">
                  <Icon name="chevronRight" className="h-3.5 w-3.5 text-slate-400" />
                </li>
              )}
              <li className="min-w-0 max-w-full">
                {c.to && !last ? (
                  <Link to={c.to} className="block truncate rounded px-0.5 hover:text-slate-900 hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span className={`block truncate px-0.5 ${last ? 'font-medium text-slate-800' : ''}`} aria-current={last ? 'page' : undefined}>
                    {c.label}
                  </span>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
