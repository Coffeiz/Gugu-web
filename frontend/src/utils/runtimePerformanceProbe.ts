type ProbeId = string | null

let sequence = 0

function enabled() {
  return import.meta.env.DEV && typeof performance !== 'undefined'
}

export function beginRuntimeCanvasProbe(label: string): ProbeId {
  if (!enabled()) return null
  const id = `runtime-business-${label}-${++sequence}`
  performance.mark(`${id}:start`)
  return id
}

export function markRuntimeCanvasProbe(id: ProbeId, phase: string) {
  if (!id || !enabled()) return
  performance.mark(`${id}:${phase}`)
}

export function measureRuntimeCanvasProbe(id: ProbeId, label: string, startPhase: string, endPhase: string) {
  if (!id || !enabled()) return
  try {
    const name = `${id}:${label}`
    performance.measure(name, `${id}:${startPhase}`, `${id}:${endPhase}`)
    const entries = performance.getEntriesByName(name, 'measure')
    const entry = entries[entries.length - 1]
    console.log('[runtime-business-performance-probe]', JSON.stringify({
      phase: 'measure', label, duration: entry?.duration ?? null,
    }))
  } catch {
    // 探针不应影响交互；热更新时部分 User Timing 标记可能已经被浏览器清掉。
  }
}

export function logRuntimeCanvasProbe(phase: string, detail: Record<string, unknown> = {}) {
  if (!import.meta.env.DEV) return
  console.log('[runtime-business-performance-probe]', JSON.stringify({ phase, ...detail }))
}
