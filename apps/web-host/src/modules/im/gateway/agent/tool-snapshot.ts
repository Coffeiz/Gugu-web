/** 仅缓存定义。每次读取先取得当前版本，工具执行仍走实时授权。 */
export function createImToolSnapshots<T>(limit = 128) {
  const entries = new Map<string, T>()
  const pending = new Map<string, Promise<T>>()
  return async (version: () => Promise<string>, load: () => Promise<T>) => {
    const key = await version()
    const cached = entries.get(key)
    if (cached !== undefined) {
      entries.delete(key)
      entries.set(key, cached)
      return { value: structuredClone(cached), hit: true }
    }
    let work = pending.get(key)
    if (!work) {
      work = (async () => {
        const value = await load()
        if (await version() !== key) throw new Error('工具目录或授权已变更，请重新准备')
        entries.set(key, structuredClone(value))
        if (entries.size > limit) entries.delete(entries.keys().next().value!)
        return value
      })()
      pending.set(key, work)
    }
    try {
      return { value: structuredClone(await work), hit: false }
    } finally {
      if (pending.get(key) === work) pending.delete(key)
    }
  }
}
