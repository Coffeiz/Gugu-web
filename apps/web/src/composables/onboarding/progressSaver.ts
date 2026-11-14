type GuidePatch = Record<string, unknown>
type GuideUpdate = (patch: GuidePatch) => Promise<unknown>

/**
 * Debounces onboarding progress writes and serializes them. Navigation remains
 * local/instant while rapid step changes collapse into the latest server state.
 */
export function createOnboardingProgressSaver(
  update: GuideUpdate,
  onSaved: (response: unknown) => void,
  delayMs = 250,
) {
  let pending: GuidePatch = {}
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<unknown> | null = null

  function enqueue(patch: GuidePatch) {
    pending = { ...pending, ...patch }
    revision += 1
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush().catch(() => {})
    }, delayMs)
  }

  async function flush(patch?: GuidePatch): Promise<unknown> {
    if (patch) {
      pending = { ...pending, ...patch }
      revision += 1
    }
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (inFlight) {
      await inFlight.catch(() => undefined)
      return flush()
    }
    if (!Object.keys(pending).length) return undefined

    const savedRevision = revision
    const current = pending
    pending = {}
    const request = update(current)
    inFlight = request
    try {
      const response = await request
      // 已有更新的本地操作时，旧响应不得覆盖尚未保存的进度。
      if (savedRevision === revision) onSaved(response)
      return response
    } finally {
      inFlight = null
      if (Object.keys(pending).length) await flush()
    }
  }

  return { enqueue, flush }
}
