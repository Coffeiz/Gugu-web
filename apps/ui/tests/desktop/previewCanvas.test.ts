// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { desktopData } from '@desktop/bridge/bridge'

it('桌面浏览器预览从 Core 保存并读取画布及其内容和连线', async () => {
  const previousUrl = window.location.href
  window.history.replaceState(null, '', '/desktop.html?desktopPreview=1')
  const canvas = { id: 7, title: '合成画布', projectId: null, data: {} }
  const results = { createCanvas: canvas, canvases: [canvas], canvasItems: [], canvasRelations: [] }
  const calls: unknown[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('/__desktop-preview/mind')
    const body = JSON.parse(String(init.body))
    calls.push(body)
    return new Response(JSON.stringify({ ok: true, result: results[body.method as keyof typeof results] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })

  try {
    expect(await desktopData.createCanvas(canvas.title)).toEqual(canvas)
    expect(await desktopData.canvases()).toEqual([canvas])
    expect(await desktopData.canvasItems(canvas.id)).toEqual([])
    expect(await desktopData.canvasRelations(canvas.id)).toEqual([])
    expect(calls).toEqual([
      { method: 'createCanvas', args: [canvas.title] },
      { method: 'canvases', args: [] },
      { method: 'canvasItems', args: [canvas.id] },
      { method: 'canvasRelations', args: [canvas.id] },
    ])
  } finally {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', previousUrl)
  }
})
