export function imMediaFilename(value: string): { name: string; ext: string } {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) || '附件', dot = leaf.lastIndexOf('.')
  return { name: Array.from((dot > 0 ? leaf.slice(0, dot) : leaf).replace(/[\x00-\x1f\x7f]/gu, '')).slice(0, 160).join('') || '附件',
    ext: dot > 0 ? leaf.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 10) || 'bin' : 'bin' }
}
export function imImageFormat(bytes: Uint8Array): { ext: string; mime: string } | null {
  const data = Buffer.from(bytes)
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' }
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' }
  if (data.subarray(0, 4).toString() === 'GIF8') return { ext: 'gif', mime: 'image/gif' }
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}
