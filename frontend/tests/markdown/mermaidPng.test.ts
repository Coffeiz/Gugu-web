import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadMermaidPng } from '@/utils/mermaidPng'

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.useRealTimers()
})

function makeSvg(viewBox: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', viewBox)
  return svg
}

describe('Mermaid PNG 导出', () => {
  it('拒绝过大的 SVG 源码，避免进入图片解码和 Canvas 分配', async () => {
    const svg = makeSvg('0 0 20 20')
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.textContent = 'x'.repeat(1_000_001)
    svg.append(text)

    await expect(downloadMermaidPng(svg)).rejects.toThrow('png_too_large')
  })

  it('拒绝依赖外部资源的 SVG，且不启动图片解码', async () => {
    const svg = makeSvg('0 0 20 20')
    const image = document.createElementNS('http://www.w3.org/2000/svg', 'image')
    image.setAttribute('href', 'https://example.invalid/chart.png')
    svg.append(image)

    await expect(downloadMermaidPng(svg)).rejects.toThrow('external_svg_resource')
  })

  it('将当前 SVG 按比例栅格化并下载为 PNG', async () => {
    vi.useFakeTimers()
    const createObjectURL = vi.fn().mockReturnValueOnce('blob:svg').mockReturnValueOnce('blob:png')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) { queueMicrotask(() => this.onload?.()) }
    })
    const context = { fillRect: vi.fn(), drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob(['png-bytes'], { type: 'image/png' }))
    })
    let downloadedName = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedName = this.download
    })

    await downloadMermaidPng(makeSvg('0 0 100 50'))
    vi.runAllTimers()

    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 200, 100)
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100)
    expect(createObjectURL.mock.calls[1][0]).toMatchObject({ type: 'image/png', size: 9 })
    expect(click).toHaveBeenCalledOnce()
    expect(downloadedName).toMatch(/^mermaid-diagram-.*\.png$/)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:svg')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:png')
  })
})
