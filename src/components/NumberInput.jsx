import { forwardRef, useLayoutEffect, useRef } from 'react'

// Text input for numbers that shows thousands separators as you type
// (1000000 → 1,000,000) while handing the parent the plain value
// ("1000000"), so every existing parser keeps working. Keeps the caret
// after the same digit when commas are added or removed.
//
//   <NumberInput value={form.income} onChange={(v) => set('income', v)} />
//
// `decimals` caps the digits after the point (default 2); 0 = whole
// numbers only.

export function cleanNumber(raw, decimals = 2) {
  let s = String(raw ?? '').replace(/[^\d.]/g, '')
  const dot = s.indexOf('.')
  if (dot !== -1) {
    const frac = s.slice(dot + 1).replace(/\./g, '')
    s = decimals > 0 ? `${s.slice(0, dot)}.${frac.slice(0, decimals)}` : s.slice(0, dot)
  }
  return s
}

export function formatNumber(raw) {
  const s = String(raw ?? '')
  if (s === '') return ''
  const [int, frac] = s.split('.')
  const grouped = (int || (frac != null ? '0' : '')).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac != null ? `${grouped}.${frac}` : grouped
}

const NumberInput = forwardRef(function NumberInput(
  { value, onChange, decimals = 2, inputMode, ...rest },
  outerRef,
) {
  const ref = useRef(null)
  const caret = useRef(null)
  const display = formatNumber(cleanNumber(value, decimals))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || caret.current == null || document.activeElement !== el) return
    // Put the caret after the same number of digits/points as before.
    let seen = 0
    let pos = 0
    while (pos < display.length && seen < caret.current) {
      if (display[pos] !== ',') seen += 1
      pos += 1
    }
    el.setSelectionRange(pos, pos)
    caret.current = null
  }, [display])

  return (
    <input
      {...rest}
      ref={(el) => {
        ref.current = el
        if (typeof outerRef === 'function') outerRef(el)
        else if (outerRef) outerRef.current = el
      }}
      type="text"
      inputMode={inputMode ?? (decimals > 0 ? 'decimal' : 'numeric')}
      autoComplete="off"
      value={display}
      onChange={(e) => {
        const before = e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length)
        caret.current = before.replace(/[^\d.]/g, '').length
        onChange(cleanNumber(e.target.value, decimals))
      }}
    />
  )
})

export default NumberInput
