/**
 * The sheet layout, matching the old Google Sheet exactly (columns A–N).
 * An order row has an Order # in column A; the rows under it with no Order #
 * are that order's machines, until the next Order #. Blank rows are fine.
 */
export const HEADERS = [
  'Order #', // A
  'Customer, Country / Machine name', // B
  'Serial Number', // C
  'Expected ship date / Built (TRUE/FALSE)', // D
  'Voltage', // E
  'Notes', // F
  'Actual ship date', // G
  'Delay (ignored)', // H
  'Down Payment $', // I
  'DP Due Date', // J
  'DP Received', // K
  'Balance $', // L
  'Balance Due Date', // M
  'Balance Received', // N
]

/**
 * Extra columns added to the right by "Download all data" so a backup can be
 * re-imported without losing anything. They are only read when row 1 has
 * exactly these headings (so other things in column O and beyond are ignored).
 */
export const HEADER_EXTRAS = {
  currency: 'Currency',
  delivery: 'Delivery equipment',
  freight: 'Freight type',
  stage: 'Stage',
} as const

/** Column widths (characters) for the downloaded files. */
export const COLUMN_WIDTHS = [9, 38, 14, 16, 9, 34, 14, 8, 14, 12, 12, 14, 14, 14, 10, 18, 14, 14, 40]
