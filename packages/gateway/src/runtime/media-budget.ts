/**
 * IM 入站附件额度：宿主提供一批的总额与文件数上限。
 *
 * 单文件上限与批次总额是两件事，不能混用：
 * - 批次总额限制「一条消息里所有附件加起来」占多少；
 * - 单文件上限限制「单个附件」能有多大。
 * 用批次总额当单文件上限，会让两个各 10MB 的文件因为合计超限而整批被拒；
 * 只留批次总额，单个文件又能吃光整批额度。
 *
 * 这两个额度与桌面附件的 IPC 传输上限无关：桌面端把文件整块放进内存过桥接，
 * IM 入站是网络下载，两者各自独立。
 */

/** 单个 IM 附件的上限（100 MB），与附件统一预算 ATTACHMENT_MAX_BYTES 保持一致。 */
export const IM_MEDIA_MAX_FILE_BYTES = 100 * 1024 * 1024
/** 一条消息内所有附件合计的上限（300 MB）。 */
export const IM_MEDIA_BATCH_BYTES = 300 * 1024 * 1024
/** 一条消息内的附件个数上限。 */
export const IM_MEDIA_MAX_FILES = 32

export interface ImMediaBudget {
  /** 本批剩余额度（字节）。 */
  readonly remaining: number
  /** 单个附件可用上限：批次剩余与单文件上限取小。 */
  readonly fileRemaining: number
  /** 记入一个附件；超过批次总额、文件数或单文件上限时返回 false。 */
  consume(size: number): boolean
}

/** 宿主提供额度，Gateway 统一检查一批实际下载的附件。引用既有附件由存储端核算。 */
export function createImMediaBudget(maxBytes: number, maxFiles = Number.MAX_SAFE_INTEGER, maxFileBytes = IM_MEDIA_MAX_FILE_BYTES): ImMediaBudget {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0
    || !Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)
    throw new RangeError('IM 附件额度无效')
  let bytes = 0
  let files = 0
  const remaining = () => files < maxFiles ? maxBytes - bytes : 0
  return {
    get remaining() { return remaining() },
    get fileRemaining() { return Math.min(remaining(), maxFileBytes) },
    consume(size: number) {
      if (!Number.isSafeInteger(size) || size <= 0 || size > remaining() || size > maxFileBytes) return false
      bytes += size
      files++
      return true
    },
  }
}
