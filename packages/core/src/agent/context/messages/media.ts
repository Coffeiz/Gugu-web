/** 将媒体载荷替换为占位文本，避免历史接口返回原始媒体数据。 */
export function sanitizeMediaPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMediaPayload)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'video' || record.type === 'audio') {
    const label = record.type === 'image' ? '图片' : record.type === 'video' ? '视频' : '音频'
    return { type: 'text', text: `[${label}已查看]` }
  }
  if (record.type === 'image_url') {
    const imageUrl = record.image_url
    const url = imageUrl && typeof imageUrl === 'object'
      ? (imageUrl as Record<string, unknown>).url
      : imageUrl
    if (typeof url === 'string' && url.startsWith('data:'))
      return { type: 'text', text: '[图片已查看]' }
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, sanitizeMediaPayload(item)]))
}
