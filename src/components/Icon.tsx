/**
 * Simple single-colour line icons (no emojis anywhere in the app; see
 * "Wording and tone" in CLAUDE.md). Drawn on a 24 × 24 grid with the current
 * text colour, so they follow the text they sit next to. Shapes in the style
 * of the open-source Lucide icon set (ISC licence).
 */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  queue: 'M4 5h16M4 12h16M4 19h10',
  plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  boards: 'M3 4h18v16H3zM9 4v16M15 4v16',
  money: 'M3 6h18v12H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M6.5 12h.01M17.5 12h.01',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1',
  wrench: 'M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.7-1.3a4 4 0 0 0-5-5L13 5zM3 21l6-6',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3',
  factory: 'M3 21V10l6 4V10l6 4V5h6v16zM7 17h2M12 17h2M17 17h2',
  cog: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  dropdown: 'M3 5h18v6H3zM15 7.5l1.5 1.5L18 7.5M3 14h12M3 18h8',
  tag: 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01',
  check: 'M4 12.5 9 17.5 20 6.5',
  checklist: 'M3 6l2 2 3-3M3 13l2 2 3-3M11 6.5h10M11 13.5h10M11 19h10',
  template: 'M3 3h18v6H3zM3 13h8v8H3zM15 13h6M15 17h6M15 21h6',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6M9 16h4',
  calendar: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  phone: 'M7 2h10v20H7zM11 18h2',
  records: 'M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z',
  hash: 'M5 9h14M5 15h14M10 3 8 21M16 3l-2 18',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  building: 'M4 21V3h11v18M15 9h5v12M8 7h3M8 11h3M8 15h3M2 21h20',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  menu: 'M4 6h16M4 12h16M4 18h16',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  printer: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  truck: 'M3 6h11v10H3zM14 9h4l3 3v4h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  split: 'M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M18 3v6a6 6 0 0 1-6 6',
  pencil: 'M16 3l5 5L8 21H3v-5z',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7',
  alert: 'M12 3 2 20h20zM12 9v5M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7.5h.01',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9 9l6 6M15 9l-6 6',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  share: 'M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6M8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  timer: 'M12 8a7 7 0 1 0 0 14 7 7 0 0 0 0-14M12 12v3M9 2h6',
} as const

export type IconName = keyof typeof PATHS

/** A line icon. Decorative by default (the text next to it says what it is). */
/* @layout-helper */
export default function Icon({ name, className = 'h-4 w-4', label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 align-[-0.15em] ${className}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
