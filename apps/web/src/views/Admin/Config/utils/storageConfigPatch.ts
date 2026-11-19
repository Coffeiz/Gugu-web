export function supportedStoragePatch(storage: Record<string, unknown>): Record<string, unknown> {
  return storage.backend === 'local' ? { storage: { ...storage } } : {}
}
