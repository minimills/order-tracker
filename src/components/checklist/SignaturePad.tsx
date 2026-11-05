// @permission-scope checklist.sign
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { MAX_SIGNATURE_BYTES } from '../../lib/checklists'

export type SignaturePadHandle = {
  isEmpty: () => boolean
  clear: () => void
  /** A small PNG of the signature (under 50 KB), or null when empty. */
  toPng: () => Promise<Blob | null>
}

const WIDTH = 600
const HEIGHT = 200

/** Sign with a finger, pen or mouse. */
const SignaturePad = forwardRef<SignaturePadHandle, { disabled?: boolean }>(function SignaturePad({ disabled }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0f172a'
  }, [])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * WIDTH, y: ((e.clientY - r.top) / r.height) * HEIGHT }
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Some browsers refuse capture; drawing still works without it.
    }
    drawing.current = true
    last.current = point(e)
    const ctx = canvas.current!.getContext('2d')!
    ctx.beginPath()
    ctx.arc(last.current.x, last.current.y, 1.2, 0, Math.PI * 2)
    ctx.fillStyle = '#0f172a'
    ctx.fill()
    setEmpty(false)
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return
    const p = point(e)
    const ctx = canvas.current!.getContext('2d')!
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
  }
  function up() {
    drawing.current = false
    last.current = null
  }

  useImperativeHandle(ref, () => ({
    isEmpty: () => empty,
    clear: () => {
      canvas.current?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT)
      setEmpty(true)
    },
    toPng: async () => {
      if (empty || !canvas.current) return null
      // Shrink until the file is small enough (a line drawing is usually ~5–15 KB).
      for (const scale of [1, 0.75, 0.5, 0.35]) {
        const c = document.createElement('canvas')
        c.width = Math.round(WIDTH * scale)
        c.height = Math.round(HEIGHT * scale)
        const ctx = c.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(canvas.current, 0, 0, c.width, c.height)
        const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
        if (blob && blob.size <= MAX_SIGNATURE_BYTES) return blob
      }
      return null
    },
  }))

  return (
    <canvas
      ref={canvas}
      width={WIDTH}
      height={HEIGHT}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      aria-label="Sign here"
      className={`block h-40 w-full touch-none rounded-md border-2 border-dashed bg-white sm:h-48 ${
        disabled ? 'border-slate-200 opacity-60' : 'border-slate-400'
      }`}
    />
  )
})

export default SignaturePad
