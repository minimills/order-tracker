import { useEffect, useState } from 'react'
import { chartDef, rangeDates, type ChartConfig, type ChartData, type ChartResult } from './dashboardCharts'
import { supabase } from './supabase'

/** Where the chosen charts of "Print Report" wait for the print page (this browser tab only). */
export const PRINT_KEY = 'bmm.dashboard.print'

/** Loads one chart's numbers (again when its dates or boards change). */
export function useChart(cfg: ChartConfig, data: ChartData) {
  const [result, setResult] = useState<ChartResult | null>(null)
  const [failed, setFailed] = useState(false)
  const def = chartDef(cfg.chart)
  const key = JSON.stringify([cfg.chart, cfg.range, cfg.from, cfg.to, cfg.boards])
  useEffect(() => {
    if (!def || !supabase) return
    let off = false
    def
      .load(data, rangeDates(cfg), cfg)
      .then((r) => !off && (setResult(r), setFailed(false)))
      .catch(() => !off && setFailed(true))
    return () => {
      off = true
    }
    // key holds everything of cfg that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, data])
  return { result, failed, def }
}

