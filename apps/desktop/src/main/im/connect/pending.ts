/** 每个平台在本机只保留最新的扫码任务。 */
export function createDesktopPairingState() {
  let pending: { key: string; value: string; expires: number } | undefined
  let operation: Promise<unknown> = Promise.resolve()

  return {
    store: {
      async get(key: string) {
        if (pending && pending.expires <= Date.now()) pending = undefined
        return pending?.key === key ? pending.value : null
      },
      async saveIfAbsent(key: string, value: string, seconds: number) {
        if (pending?.key === key && pending.expires > Date.now()) return false
        pending = { key, value, expires: Date.now() + seconds * 1000 }
        return true
      },
      async delete(key: string) { if (pending?.key === key) pending = undefined },
    },
    clear() { pending = undefined },
    serialize<T>(work: () => Promise<T>) {
      const next = operation.then(work)
      operation = next.catch(() => {})
      return next
    },
  }
}
