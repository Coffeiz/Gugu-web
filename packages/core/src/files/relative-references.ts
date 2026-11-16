/** 查找范围由 Host 绑定到已授权的 owner/项目/工作区；Core 仅使用逻辑路径。 */
export interface RelativeReferenceLookup<File, Folder> {
  fileAt(directory: readonly string[], name: string): Promise<File | null>
  folderAt(directory: readonly string[], name: string): Promise<Folder | null>
}

function parts(value: string): string[] | null {
  // Python urllib.parse.unquote 默认替换非法 UTF-8，保留不完整的百分号序列。
  const decoded = value.replace(/(?:%[\da-f]{2})+/gi, run =>
    new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), byte => Number.parseInt(byte, 16))))
    .replace(/[\t\r\n]/g, '').replace(/^[\u0000-\u0020]+/, '')
  const path = decoded.split(/[?#]/, 1)[0] ?? ''
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || path.startsWith('/') || path.startsWith('\\')
    || path.includes('\\') || path.includes('\0')) return null
  const result = path.split('/').filter(part => part !== '' && part !== '.')
  return result.length ? result : null
}

/** 与 Python 文件引用一致：逐段查目录、禁止越过 scope 根，文件匹配优先于同名目录。 */
export async function resolveRelativeReferences<File, Folder>(
  sourceDirectory: readonly string[], paths: readonly string[], lookup: RelativeReferenceLookup<File, Folder>,
): Promise<Array<{ path: string; file: File | null; folder: Folder | null }>> {
  const result: Array<{ path: string; file: File | null; folder: Folder | null }> = []
  for (const original of paths) {
    const segments = parts(original), directory = [...sourceDirectory]
    let valid = segments !== null
    for (const part of segments?.slice(0, -1) ?? []) {
      if (part === '..') {
        if (!directory.length) { valid = false; break }
        directory.pop()
      } else if (await lookup.folderAt(directory, part) !== null) directory.push(part)
      else { valid = false; break }
    }
    const name = segments?.at(-1)
    if (!valid || !name || name === '..') { result.push({ path: original, file: null, folder: null }); continue }
    const file = await lookup.fileAt(directory, name)
    result.push({ path: original, file, folder: file !== null ? null : await lookup.folderAt(directory, name) })
  }
  return result
}
