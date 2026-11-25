export interface SearchFilesystemRoot {
  readonly id: string
  readonly label: string
}
export interface SearchFilesystemEntry {
  readonly name: string
  readonly relativePath: string
  readonly kind: 'file' | 'directory'
}
export interface SearchFilesystemScanOptions {
  readonly roots: readonly SearchFilesystemRoot[]
  readonly maxEntries: number
  readonly concurrency?: number
  readonly signal?: AbortSignal
  readDirectory(root: SearchFilesystemRoot, relativeDirectory: string, signal?: AbortSignal): Promise<readonly SearchFilesystemEntry[]>
  onEntry(root: SearchFilesystemRoot, entry: SearchFilesystemEntry): void | Promise<void>
}
export interface SearchFilesystemScanResult {
  readonly scannedEntries: number
  readonly partial: boolean
}
type Directory = { root: SearchFilesystemRoot; relativePath: string }

/** 有界并发、按层广度优先扫描；宿主负责 readDirectory 的路径授权和符号链接检查。 */
export async function scanFilesystem(options: SearchFilesystemScanOptions): Promise<SearchFilesystemScanResult> {
  const concurrency = options.concurrency ?? 4
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError('搜索扫描边界无效')
  let frontier: Directory[] = options.roots.map(root => ({ root, relativePath: '' }))
  let scannedEntries = 0
  while (frontier.length) {
    options.signal?.throwIfAborted()
    const next: Directory[] = []
    for (let offset = 0; offset < frontier.length; offset += concurrency) {
      options.signal?.throwIfAborted()
      const batch = frontier.slice(offset, offset + concurrency)
      const entries = await Promise.all(batch.map(directory => options.readDirectory(directory.root, directory.relativePath, options.signal)))
      options.signal?.throwIfAborted()
      for (let index = 0; index < batch.length; index++) {
        const directory = batch[index]!
        for (const entry of entries[index]!) {
          options.signal?.throwIfAborted()
          if (scannedEntries >= options.maxEntries) return { scannedEntries, partial: true }
          scannedEntries++
          await options.onEntry(directory.root, entry)
          if (entry.kind === 'directory') next.push({ root: directory.root, relativePath: entry.relativePath })
        }
      }
    }
    frontier = next
  }
  return { scannedEntries, partial: false }
}
