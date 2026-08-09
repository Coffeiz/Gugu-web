/**
 * 文件系统 Runtime 接入用的纯 ID/类型辅助函数。
 *
 * 按方案第 4 节约束：这里不隐藏 Core API，也不维护另一份对象/Surface 注册表——
 * 只提供 `scope:kind:id` 形式的对象 ID 生成/解析，供业务侧（Files/index.vue 等）
 * 直接调用 `runtime.objects`/`runtime.surfaces`/`runtime.targets`/`runtime.onAction()`。
 */

export type FileObjectKind = 'file' | 'folder'

/** 生成符合 `scope:kind:id` 约定的对象 ID，例如 `files:file:123` / `files:folder:45`。 */
export function fileObjectId(scope: string, kind: FileObjectKind, id: number | string): string {
  return `${scope}:${kind}:${id}`
}

/** 从对象 ID 反解出 kind 与真实业务 id；不是本约定形式时返回 null。 */
export function parseFileObjectId(scope: string, objectId: string): { kind: FileObjectKind; id: string } | null {
  const filePrefix = `${scope}:file:`
  const folderPrefix = `${scope}:folder:`
  if (objectId.startsWith(filePrefix)) return { kind: 'file', id: objectId.slice(filePrefix.length) }
  if (objectId.startsWith(folderPrefix)) return { kind: 'folder', id: objectId.slice(folderPrefix.length) }
  return null
}

/** 浏览区稳定 Surface ID：当前目录内容始终渲染到同一个 Surface，目录切换不销毁它。 */
export function browserSurfaceId(scope: string): string {
  return `${scope}:surface:browser`
}

/** 文件夹卡自身的语义 Surface ID（既是可拖动 Object，也是这个 Surface 的落点）。 */
export function folderSurfaceId(scope: string, folderId: number | string): string {
  return `${scope}:surface:folder:${folderId}`
}

/** 从文件夹语义 Surface ID 反解出 folderId；不匹配时返回 null。 */
export function parseFolderSurfaceId(scope: string, surfaceId: string): string | null {
  const prefix = `${scope}:surface:folder:`
  return surfaceId.startsWith(prefix) ? surfaceId.slice(prefix.length) : null
}

/** 面包屑段的语义 Target/Surface ID，按面包屑在 navPath 中的下标区分。 */
export function breadcrumbSurfaceId(scope: string, idx: number): string {
  return `${scope}:breadcrumb:${idx}`
}

/** 从面包屑语义 Surface ID 反解出下标；不匹配时返回 null。 */
export function parseBreadcrumbSurfaceId(scope: string, surfaceId: string): number | null {
  const prefix = `${scope}:breadcrumb:`
  if (!surfaceId.startsWith(prefix)) return null
  const idx = Number(surfaceId.slice(prefix.length))
  return Number.isNaN(idx) ? null : idx
}
