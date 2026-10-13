import { useEffect, useRef } from 'react'
import { useReducedMotion } from '../../hooks/useReducedMotion'

const CELL = 26
const GLYPHS = ['T', '(', ')', '|', '▐', '┴', '┤', '▀']
const FRAME_MS = 60

/** Stable pseudo-random value in [0, 1) for a grid cell. */
function hash(column: number, row: number): number {
  const value = Math.sin(column * 127.1 + row * 311.7) * 43758.5453
  return value - Math.floor(value)
}

/**
 * Decorative field of small glyphs that drift in a slow ribbon. Purely visual:
 * hidden from assistive tech, and drawn as a single still frame when the user
 * prefers reduced motion.
 */
export function GlyphField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const styles = getComputedStyle(document.documentElement)
    const ink = styles.getPropertyValue('--color-foreground').trim()
    const font = styles.getPropertyValue('--font-mono').trim()
    let width = 0
    let height = 0
    let frame = 0
    let last = 0

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }

    const draw = (time: number) => {
      const t = time / 1000
      context.clearRect(0, 0, width, height)
      context.fillStyle = ink
      context.font = `12px ${font}`
      context.textBaseline = 'middle'
      for (let row = 0; row * CELL < height; row += 1) {
        for (let column = 0; column * CELL < width; column += 1) {
          const nx = (column * CELL) / Math.max(width, 1)
          const ny = (row * CELL) / Math.max(height, 1)
          const ribbon =
            Math.sin(nx * 5 + Math.sin(ny * 4 + t * 0.25) * 1.6 + t * 0.18) *
            Math.cos(ny * 3.2 - nx * 1.5 - t * 0.12)
          const seed = hash(column, row)
          // Fade toward the left so the field never competes with the text.
          const reach = Math.min(1, Math.max(0, (nx - 0.3) / 0.35))
          const strength = (ribbon - 0.15 - seed * 0.25) * reach
          if (strength <= 0) continue
          context.globalAlpha = Math.min(0.34, 0.08 + strength * 0.5)
          const glyph = GLYPHS[Math.floor(seed * GLYPHS.length)] ?? '|'
          context.fillText(glyph, column * CELL, row * CELL + CELL / 2)
        }
      }
      context.globalAlpha = 1
    }

    const loop = (time: number) => {
      frame = requestAnimationFrame(loop)
      if (document.hidden || time - last < FRAME_MS) return
      last = time
      draw(time)
    }

    resize()
    draw(0)
    const observer = new ResizeObserver(() => {
      resize()
      draw(last)
    })
    observer.observe(canvas)
    if (!reduced) frame = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [reduced])

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />
}
