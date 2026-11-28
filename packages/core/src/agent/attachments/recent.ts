import type { RecentAttachment } from '../tools/files/index.js'

export interface RecentAttachmentRow {
  readonly attach_id: string
  readonly name: string | null
  readonly ext: string | null
  readonly kind: string | null
  readonly platform: string | null
  readonly size: string | number | null
  readonly img_width: number | null
  readonly img_height: number | null
  readonly duration: number | null
  readonly created_at: Date | string
}

const draftTtlSeconds = 48 * 60 * 60
const legacyAgeTtlSeconds = 7 * 24 * 60 * 60

function stagedAbout(ttlLeft: number): string {
  if (!Number.isFinite(ttlLeft) || ttlLeft < 0) return '未知'
  const elapsed = Math.max(0, legacyAgeTtlSeconds - ttlLeft)
  if (elapsed < 3600) return `约${Math.max(1, Math.floor(elapsed / 60))}分钟前`
  if (elapsed < 86400) return `约${Math.floor(elapsed / 3600)}小时前`
  return `约${Math.floor(elapsed / 86400)}天前`
}

function common(row: RecentAttachmentRow) {
  return {
    attach_id: row.attach_id,
    name: row.name ?? '',
    ext: row.ext ?? '',
    kind: row.kind ?? 'binary',
    platform: row.platform,
    size_bytes: Number(row.size ?? 0),
    img_width: row.img_width === null ? null : Number(row.img_width),
    img_height: row.img_height === null ? null : Number(row.img_height),
  }
}

/** Web 与 Desktop 共用附件元数据投影，不暴露 storage key 或正文。 */
export function projectRecentAttachments(
  staged: readonly RecentAttachmentRow[],
  attached: readonly RecentAttachmentRow[],
  now = Date.now(),
): RecentAttachment[] {
  if (!Number.isFinite(now)) throw new RangeError('附件列表时钟无效')
  return [
    ...staged.map(row => {
      const createdAt = new Date(row.created_at).getTime()
      const elapsed = Number.isFinite(createdAt) ? Math.max(0, (now - createdAt) / 1000) : Number.NaN
      const ttlLeft = Number.isFinite(elapsed) ? Math.max(0, Math.trunc(draftTtlSeconds - elapsed)) : Number.NaN
      return { ...common(row), state: 'draft' as const, staged_about: stagedAbout(ttlLeft) }
    }),
    ...attached.map(row => ({ ...common(row), state: 'attached' as const,
      duration: row.duration === null ? null : Number(row.duration) })),
  ]
}
