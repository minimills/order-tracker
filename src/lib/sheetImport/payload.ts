import type { CheckResult } from './validate'

/** Turns the checked preview into what import_sheet() receives, plus counts for the confirm box. */
export function buildPayload(result: CheckResult) {
  const included = result.orders.filter((o) => o.draft.include)
  const board = new Set(result.boardOrder)
  // New board orders go last, in board order, so they join the board in that order.
  const sequence = [...included.filter((o) => !board.has(o)), ...result.boardOrder]

  let machines = 0
  let payments = 0
  const payload = sequence.map((o) => {
    // Rows still missing a machine type are errors (Import is blocked); leave them out here.
    const ms = o.machines.filter((m) => (m.action === 'new' || m.action === 'update') && m.type)
    machines += ms.length
    const d = o.draft
    const dp =
      d.dpAmount || d.dpDue || d.dpReceived || d.dpReceivedAmount
        ? {
            amount: o.dpAmount,
            due_date: d.dpDue || null,
            received_date: d.dpReceived || null,
            received_amount: d.dpReceivedAmount ? Number(d.dpReceivedAmount) : null,
          }
        : null
    const balance =
      o.total !== null || d.balanceDue || d.balanceReceived || d.balanceReceivedAmount
        ? {
            due_date: d.balanceDue || null,
            received_date: d.balanceReceived || null,
            received_amount: d.balanceReceivedAmount ? Number(d.balanceReceivedAmount) : null,
          }
        : null
    if (dp) payments++
    if (balance) payments++
    const notes = [d.notes.trim(), o.extraNotes.length ? `Also: ${o.extraNotes.join(', ')}` : ''].filter(Boolean).join('\n')
    return {
      order_number: o.orderNumber,
      split_number: o.split,
      customer: o.customerName ? { name: o.customerName, country: o.country, state_province: o.state } : null,
      stage: o.stage,
      currency: d.currency ? o.currency : o.existing ? null : 'CAD',
      order_total: o.total,
      expected_ship_date: d.expected || null,
      actual_ship_date: d.actual || null,
      voltage: o.voltage,
      delivery_equipment: o.delivery,
      freight_type: o.freight,
      notes: notes || null,
      machines: ms.map((m) => ({
        machine_type_id: m.type!.id,
        serial_number: m.serial,
        serial_manual: m.serialManual,
        ready: m.draft.built || o.stage === 'Shipped',
        notes: m.draft.notes || null,
        source_row: m.draft.row,
      })),
      down_payment: dp,
      balance,
      source_row: d.row,
      // Not read by import_sheet; saved right after it (empty cells never overwrite).
      quote_number: d.quote.trim() || null,
      invoice_number: d.invoice.trim() || null,
    }
  })

  const skippedOrders = result.orders.filter((o) => !o.draft.include)
  const skipped =
    skippedOrders.length +
    included.reduce((n, o) => n + o.machines.filter((m) => m.action === 'skip').length, 0)
  return {
    payload,
    skipped,
    counts: {
      newOrders: included.filter((o) => !o.existing).length,
      updatedOrders: included.filter((o) => o.existing).length,
      machines,
      payments,
      notMachines: included.reduce((n, o) => n + o.extraNotes.length, 0),
    },
  }
}
