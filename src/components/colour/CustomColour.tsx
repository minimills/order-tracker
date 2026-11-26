import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cmykToRgb, hexToRgb, hsvToRgb, normalizeHex, recentColours, rememberColour, rgbToCmyk, rgbToHex, rgbToHsv, type Hsv } from '../../lib/colour'
import { buttonClass, secondaryButtonClass } from '../form'

const numBox = 'w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums focus:border-slate-500 focus:outline-none'

/**
 * The "+" after a row of preset colours: opens the full colour picker. When
 * the chosen colour is not one of the presets, it is shown (selected) next to
 * the "+", so people see what they picked.
 */
/* @layout-helper */
export function CustomColourButton({
  value,
  presets,
  onChange,
  label,
  disabled = false,
  round = true,
}: {
  /** The current colour (a preset value or a colour code). */
  value: string | null | undefined
  /** Colour codes of the presets (so a custom colour is recognised). */
  presets: string[]
  onChange: (hex: string) => void
  label: string
  disabled?: boolean
  round?: boolean
}) {
  const [open, setOpen] = useState(false)
  const hex = value ? normalizeHex(value) : null
  const custom = hex && !presets.some((p) => normalizeHex(p) === hex) ? hex : null
  const shape = round ? 'rounded-full' : 'rounded'
  return (
    <>
      {custom && (
        <button
          type="button"
          aria-pressed="true"
          aria-label={`Custom colour ${custom}`}
          title={custom}
          disabled={disabled}
          onClick={() => setOpen(true)}
          className={`h-7 w-7 ${shape} ring-2 ring-slate-900 ring-offset-2`}
          style={{ backgroundColor: custom }}
        />
      )}
      <button
        type="button"
        aria-label={`${label}: choose a custom colour`}
        title="Choose a custom colour"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`flex h-7 w-7 items-center justify-center ${shape} border border-dashed border-slate-400 bg-white text-base leading-none text-slate-600 hover:border-slate-700 hover:text-slate-900 disabled:opacity-50`}
      >
        +
      </button>
      {open && (
        <ColourPickerDialog
          title={label}
          initial={hex ?? '#2a78d6'}
          onClose={() => setOpen(false)}
          onPick={(c) => {
            rememberColour(c)
            onChange(c)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

/** The full colour picker: colour area + hue slider, HEX, RGB and CMYK boxes, recent colours. */
/* @layout-helper */
export function ColourPickerDialog({ title, initial, onClose, onPick }: { title: string; initial: string; onClose: () => void; onPick: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(initial)))
  // What people are typing (kept until it is a valid value, so typing is never fought).
  const [typing, setTyping] = useState<Record<string, string>>({})
  const [recent] = useState(recentColours)
  const area = useRef<HTMLDivElement>(null)
  const hue = useRef<HTMLDivElement>(null)

  const rgb = hsvToRgb(hsv)
  const hex = rgbToHex(rgb)
  const cmyk = rgbToCmyk(rgb)

  // Escape closes only this window (not the window it was opened from).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const setFromHex = (h: string) => {
    const n = normalizeHex(h)
    if (n) setHsv(rgbToHsv(hexToRgb(n)))
  }
  const field = (key: string, shown: string | number) => (key in typing ? typing[key] : String(shown))
  const type = (key: string, text: string, apply: (t: string) => boolean) => {
    if (apply(text)) setTyping(({ [key]: _gone, ...rest }) => rest)
    else setTyping((t) => ({ ...t, [key]: text }))
  }
  const clearTyping = () => setTyping({})

  const typeHex = (t: string) => {
    const n = normalizeHex(t)
    if (!n || t.replace('#', '').length !== 6) return false
    setFromHex(n)
    return true
  }
  const typeRgb = (part: 'r' | 'g' | 'b') => (t: string) => {
    if (!/^\d{1,3}$/.test(t) || Number(t) > 255) return false
    setHsv(rgbToHsv({ ...rgb, [part]: Number(t) }))
    return true
  }
  const typeCmyk = (part: 'c' | 'm' | 'y' | 'k') => (t: string) => {
    if (!/^\d{1,3}$/.test(t) || Number(t) > 100) return false
    setHsv(rgbToHsv(cmykToRgb({ ...cmyk, [part]: Number(t) })))
    return true
  }

  const drag = (ref: RefObject<HTMLDivElement | null>, move: (x: number, y: number) => void) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    clearTyping()
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      move(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    }
    at(e)
    el.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => at(ev)
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }
  const keyArea = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key]
    if (!d) return
    e.preventDefault()
    clearTyping()
    setHsv((c) => ({ ...c, s: Math.min(1, Math.max(0, c.s + d[0])), v: Math.min(1, Math.max(0, c.v + d[1])) }))
  }
  const keyHue = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 15 : 3
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : 0
    if (!d) return
    e.preventDefault()
    clearTyping()
    setHsv((c) => ({ ...c, h: Math.min(360, Math.max(0, c.h + d)) }))
  }

  const box = (key: string, label: string, shown: number, apply: (t: string) => boolean, max: number) => (
    <label className="min-w-0 flex-1 text-xs text-slate-600">
      {label}
      <input
        className={numBox}
        inputMode="numeric"
        aria-label={`${label} (0 to ${max})`}
        value={field(key, shown)}
        onChange={(e) => type(key, e.target.value, apply)}
        onBlur={() => setTyping(({ [key]: _gone, ...rest }) => rest)}
      />
    </label>
  )

  return createPortal(
    <div className="glass-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-black/40 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="glass-panel max-h-[90vh] w-full overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:max-w-sm sm:rounded-lg">
        <h2 className="text-lg font-semibold">Choose a Colour</h2>
        <p className="text-sm text-slate-600">{title}</p>

        <div className="mt-3 space-y-3">
          {/* Saturation (across) and brightness (up) */}
          <div
            ref={area}
            role="slider"
            tabIndex={0}
            aria-label="Colour shade: left and right for strength, up and down for brightness"
            aria-valuetext={hex}
            className="keep-light relative h-40 w-full cursor-crosshair touch-none select-none rounded-md"
            style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)`, backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)' }}
            onPointerDown={(e) => drag(area, (x, y) => setHsv((c) => ({ ...c, s: x, v: 1 - y })))(e)}
            onKeyDown={keyArea}
          >
            <span
              className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hex }}
            />
          </div>
          {/* Hue */}
          <div
            ref={hue}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            className="keep-light relative h-4 w-full cursor-pointer touch-none select-none rounded-full"
            style={{ backgroundImage: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
            onPointerDown={(e) => drag(hue, (x) => setHsv((c) => ({ ...c, h: x * 360 })))(e)}
            onKeyDown={keyHue}
          >
            <span
              className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
              style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
            />
          </div>

          <div className="flex items-end gap-2">
            <span className="keep-light h-9 w-12 shrink-0 rounded-md border border-slate-300" style={{ backgroundColor: hex }} aria-hidden="true" />
            <label className="min-w-0 flex-1 text-xs text-slate-600">
              HEX
              <input
                className={`${numBox} font-mono`}
                aria-label="HEX colour code"
                value={field('hex', hex)}
                onChange={(e) => type('hex', e.target.value, typeHex)}
                onBlur={() => setTyping(({ hex: _gone, ...rest }) => rest)}
                maxLength={7}
              />
            </label>
          </div>
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">RGB</legend>
            <div className="flex gap-2">
              {box('r', 'Red', rgb.r, typeRgb('r'), 255)}
              {box('g', 'Green', rgb.g, typeRgb('g'), 255)}
              {box('b', 'Blue', rgb.b, typeRgb('b'), 255)}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-xs font-medium text-slate-700">CMYK (%)</legend>
            <div className="flex gap-2">
              {box('c', 'Cyan', cmyk.c, typeCmyk('c'), 100)}
              {box('m', 'Magenta', cmyk.m, typeCmyk('m'), 100)}
              {box('y', 'Yellow', cmyk.y, typeCmyk('y'), 100)}
              {box('k', 'Black', cmyk.k, typeCmyk('k'), 100)}
            </div>
          </fieldset>

          <div>
            <p className="text-xs font-medium text-slate-700">Recently used</p>
            {recent.length === 0 ? (
              <p className="text-xs text-slate-500">No recent colours yet.</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {recent.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use recent colour ${c}`}
                    aria-pressed={c === hex}
                    title={c}
                    onClick={() => {
                      clearTyping()
                      setFromHex(c)
                    }}
                    className={`keep-light h-7 w-7 rounded-full ring-offset-2 ${c === hex ? 'ring-2 ring-slate-900' : 'ring-1 ring-black/10'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={buttonClass} onClick={() => onPick(hex)}>
            Use This Colour
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
