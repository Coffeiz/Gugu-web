const MAX_SVG_BYTES = 1_000_000
const MAX_PNG_BYTES = 8_000_000
const MAX_PNG_PIXELS = 16_000_000
const MAX_PNG_DIMENSION = 8192

function readSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox.baseVal
  const width = viewBox.width || Number.parseFloat(svg.getAttribute('width') || '')
  const height = viewBox.height || Number.parseFloat(svg.getAttribute('height') || '')
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('invalid_svg_size')
  }
  return { width, height }
}

function assertNoExternalImages(svg: SVGSVGElement): void {
  for (const image of svg.querySelectorAll('image')) {
    const href = image.getAttribute('href') || image.getAttribute('xlink:href') || ''
    if (href && !href.startsWith('data:image/')) throw new Error('external_svg_resource')
  }
}

async function toPngBlob(svg: SVGSVGElement): Promise<Blob> {
  const serialized = new XMLSerializer().serializeToString(svg)
  if (new Blob([serialized]).size > MAX_SVG_BYTES) throw new Error('png_too_large')
  assertNoExternalImages(svg)
  const { width: sourceWidth, height: sourceHeight } = readSvgSize(svg)
  const scale = Math.min(
    2,
    MAX_PNG_DIMENSION / sourceWidth,
    MAX_PNG_DIMENSION / sourceHeight,
    Math.sqrt(MAX_PNG_PIXELS / (sourceWidth * sourceHeight)),
  )
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('png_too_large')
  const width = Math.max(1, Math.floor(sourceWidth * scale))
  const height = Math.max(1, Math.floor(sourceHeight * scale))
  if (width * height > MAX_PNG_PIXELS) throw new Error('png_too_large')

  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = new Image()
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('svg_image_load_failed'))
    })
    image.src = url
    await loaded
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas_unavailable')
    const dark = document.documentElement.dataset.theme === 'dark'
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface-card-solid').trim()
      || (dark ? '#24212b' : '#ffffff')
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('png_encode_failed')
    if (blob.size > MAX_PNG_BYTES) throw new Error('png_too_large')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 将已消毒的 Mermaid SVG 下载为受像素和文件大小限制的 PNG。 */
export async function downloadMermaidPng(svg: SVGSVGElement): Promise<void> {
  const blob = await toPngBlob(svg)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mermaid-diagram-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
