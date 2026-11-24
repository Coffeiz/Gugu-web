import type { ConflictDecision, ConflictItem } from '@/components/common/overlays/UploadConflictDialog.vue'
import { splitName } from '@/utils/fileParse'
import { pathFilesApi as httpPathFiles, type PathFileRef } from '@/services/api'
import type { PathFileAccess } from '@/services/pathFileAccess'

/** 一个待上传项：文件本体 + 相对路径（无子文件夹时就是文件名本身）。 */
export interface UploadItem {
  file: File
  relativePath: string
}

export async function uploadWorkspaceFile(
  target: PathFileRef,
  item: UploadItem,
  onProgress: (progress: number) => void,
  showConflicts: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>,
  isCurrent: () => boolean,
  pathFilesApi: PathFileAccess = httpPathFiles,
) {
  const parts = item.relativePath.split('/')
  let name = parts.pop()!
  let parent = target.relativePath
  for (const part of parts) {
    if (!isCurrent()) return false
    const relativePath = [parent, part].filter(Boolean).join('/')
    try {
      await pathFilesApi.createFolder({ directoryId: target.directoryId, relativePath })
    } catch (error) {
      if ((error as { status?: number })?.status !== 409) throw error
      const entries = await pathFilesApi.entries(target.directoryId, parent)
      if (!entries.some(entry => entry.kind === 'directory' && entry.name === part)) throw error
    }
    parent = relativePath
  }
  if (!isCurrent()) return false
  const entries = await pathFilesApi.entries(target.directoryId, parent)
  const existing = entries.find(entry => entry.name === name)
  let overwrite = false
  if (existing) {
    if (!isCurrent()) return false
    const choices = await showConflicts([{ filename: item.relativePath, canOverwrite: existing.kind === 'file' }])
    const action = choices.get(item.relativePath)?.action
    if (!action || action === 'skip') return false
    overwrite = action === 'overwrite' && existing.kind === 'file'
    if (!overwrite) {
      const { base, ext } = splitName(name)
      const names = new Set(entries.map(entry => entry.name))
      for (let i = 1; ; i++) {
        const candidate = `${base || name} (${i})${base && ext ? `.${ext}` : ''}`
        if (names.has(candidate)) continue
        name = candidate
        break
      }
    }
  }
  if (!isCurrent()) return false
  await pathFilesApi.upload({
    directoryId: target.directoryId, relativePath: [parent, name].filter(Boolean).join('/'),
  }, item.file, onProgress, overwrite)
  return true
}

// ── 拖放解析：把 DataTransfer 展开成扁平的 {file, relativePath}[] ─────────────
// 文件夹结构靠 webkitGetAsEntry()：dataTransfer.items 只在 drop 事件处理函数的**同步**阶段
// 有效（部分浏览器会在下一个事件循环把它清空），必须先同步取出所有 entry，再对 entry 对象
// 做异步递归遍历（entry 本身不受这个限制）。老浏览器没有这个 API 时退回扁平 FileList——
// 拖文件夹进来会被浏览器当空文件，但至少不报错、单文件拖拽不受影响。

function readEntriesAsync(reader: any): Promise<any[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

async function walkEntry(entry: any, prefix: string, out: UploadItem[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject))
    out.push({ file, relativePath: prefix + entry.name })
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries() 单次可能只返回部分结果（规范允许），要循环读到返回空数组为止
    let batch: any[]
    do {
      batch = await readEntriesAsync(reader)
      await Promise.all(batch.map(child => walkEntry(child, prefix + entry.name + '/', out)))
    } while (batch.length > 0)
  }
}

export async function readDroppedEntries(dataTransfer: DataTransfer): Promise<UploadItem[]> {
  const items = dataTransfer?.items
  if (items && items.length && typeof (items[0] as any)?.webkitGetAsEntry === 'function') {
    const entries = [...items].map(it => (it as any).webkitGetAsEntry?.()).filter(Boolean)
    if (entries.length) {
      const out: UploadItem[] = []
      await Promise.all(entries.map(e => walkEntry(e, '', out)))
      return out
    }
  }
  // 兜底：不支持 entry API，或没拿到任何 entry——退回扁平 FileList
  return filesToItems(dataTransfer?.files ?? [])
}

/** 把普通 FileList/File[]（如 <input type="file"> 选择器，没有文件夹结构）转成 UploadItem[]。 */
export function filesToItems(files: FileList | File[]): UploadItem[] {
  return [...files].map(file => ({ file, relativePath: file.name }))
}
