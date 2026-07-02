import { foldersApi } from '@/services/api'
import { pLimit, UPLOAD_CONCURRENCY } from '@/utils/concurrency'

/** 一个待上传项：文件本体 + 相对路径（无子文件夹时就是文件名本身）。 */
export interface UploadItem {
  file: File
  relativePath: string
}

/** 解析后的上传项：多了「应该落在哪个 folder_id」（null = 落在 baseFolderId/项目·个人根）。 */
export interface ResolvedUploadItem {
  file: File
  relativePath: string
  folderId: number | null
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

// ── 文件夹树解析：按 relativePath 里的目录部分，创建缺失的子文件夹（同名复用，不重复建）──
// 一次性拉全量文件夹建索引，逐级 resolve + 结果缓存——文件夹数量在个人使用场景下不大，
// 换一次 /folders/all 比逐级查询/为每个文件重复创建同名文件夹更简单可靠。
export async function resolveFolderTree(
  items: UploadItem[],
  opts: {
    projectId?: number | null
    baseFolderId?: number | null
    /** 每新建一个文件夹（非复用已有的）就同步回调一次——宿主用它把新文件夹实时插进自己的
     * 本地缓存/列表（如 filesCache store 的 addFolder），否则上传完文件夹「看不见」，得等
     * 手动刷新页面重新拉取才会出现（本地缓存不会自己知道服务端多了这条）。 */
    onFolderCreated?: (folder: { id: number; projectId?: number | null; parentId?: number | null; name: string }) => void
  },
): Promise<ResolvedUploadItem[]> {
  const baseFolderId = opts.baseFolderId ?? null
  const dirsNeeded = new Set<string>()
  for (const { relativePath } of items) {
    const idx = relativePath.lastIndexOf('/')
    if (idx > 0) dirsNeeded.add(relativePath.slice(0, idx))
  }
  if (dirsNeeded.size === 0) {
    return items.map(({ file, relativePath }) => ({ file, relativePath, folderId: baseFolderId }))
  }

  const projectId = opts.projectId ?? null
  const all = await foldersApi.all()
  // `${parentId ?? 'root'}:${name}` -> id，只认同一空间（同项目 / 同个人根）下的文件夹，
  // 避免把「项目 A 下的 docs」错认成「项目 B 下同名 docs」
  const byParentName = new Map<string, number>()
  for (const f of all) {
    if ((f.projectId ?? null) !== projectId) continue
    byParentName.set(`${f.parentId ?? 'root'}:${f.name}`, f.id)
  }

  const pathToId = new Map<string, number | null>()
  pathToId.set('', baseFolderId)   // 空路径 = 落点本身（当前文件夹 / 项目·个人根）

  async function resolvePath(path: string): Promise<number | null> {
    if (pathToId.has(path)) return pathToId.get(path)!
    const idx = path.lastIndexOf('/')
    const parentPath = idx > -1 ? path.slice(0, idx) : ''
    const name = idx > -1 ? path.slice(idx + 1) : path
    const parentId = await resolvePath(parentPath)
    const key = `${parentId ?? 'root'}:${name}`
    let id = byParentName.get(key)
    if (id == null) {
      const created = await foldersApi.create(projectId, name, parentId)
      id = created.id
      byParentName.set(key, id)
      opts.onFolderCreated?.(created)
    }
    pathToId.set(path, id)
    return id
  }

  // 顺序创建（不并发）：同一路径靠 pathToId 缓存去重即可，没必要为建文件夹这种低频操作
  // 引入并发创建同名文件夹的竞态风险
  for (const dir of dirsNeeded) await resolvePath(dir)

  return items.map(({ file, relativePath }) => {
    const idx = relativePath.lastIndexOf('/')
    const dir = idx > -1 ? relativePath.slice(0, idx) : ''
    return { file, relativePath, folderId: pathToId.get(dir) ?? baseFolderId }
  })
}

/**
 * 编排：解析文件夹树 → 按并发上限逐个上传。宿主自己的「怎么上传一个文件」（走 presign/OSS
 * 还是本地代理 POST、怎么建/更新幽灵卡）通过 uploadOne 回调传入，这里只管「文件该落在哪个
 * folder_id」和并发调度，不 assume 具体上传方式——UploadModal（presign/OSS 双模式）和文件库/
 * 项目编辑卡（纯本地代理 POST）复用同一套编排，各自的 uploadOne 不用改。
 * uploadOne 第三个参数是这个文件的 relativePath——宿主据此判断「这个文件是不是某个被拖入的
 * 文件夹的一部分」，从而决定是显示单文件幽灵卡还是汇总进文件夹级进度（见各宿主 uploadFiles）。
 */
export async function uploadFilesWithFolders(
  items: UploadItem[],
  opts: {
    projectId?: number | null
    baseFolderId?: number | null
    concurrency?: number
    onFolderCreated?: (folder: { id: number; projectId?: number | null; parentId?: number | null; name: string }) => void
    uploadOne: (file: File, folderId: number | null, relativePath: string) => Promise<any>
  },
): Promise<PromiseSettledResult<any>[]> {
  if (!items.length) return []
  const resolved = await resolveFolderTree(items, opts)
  const limit = pLimit(opts.concurrency ?? UPLOAD_CONCURRENCY)
  return Promise.allSettled(
    resolved.map(({ file, folderId, relativePath }) => limit(() => opts.uploadOne(file, folderId, relativePath))),
  )
}
