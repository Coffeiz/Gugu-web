/**
 * 文件大小展示格式——纯函数，从 Files/index.vue 抽出，行为逐字保持：
 *   0 / 假值 → '0 B'；GB、MB 保留 1 位小数，KB 取整，1KB 以下按 B。
 * 注意：UploadModal.vue 另有一套按 1e6/1024 的字节格式化，口径不同，本次不合并
 *（合并会改其展示输出，属行为变更而非等价替换）。
 */
import { formatFileSize } from './formatters'

export function fmtBytes(n: number | null | undefined): string {
  return formatFileSize(n ?? 0)
}
