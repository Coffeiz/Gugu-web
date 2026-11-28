// @vitest-environment jsdom
import { deserialize, serialize } from 'node:v8'
import { reactive } from 'vue'
import { expect, it, vi } from 'vitest'
import { desktopData } from '@desktop/bridge/bridge'

it('桌面画布能跨 IPC 保存响应式数据中的连线锚点与视角', async () => {
  const data = reactive({
    x: 12,
    y: 24,
    scale: 1,
    relationAnchors: { 7: { srcSide: 'right', dstSide: 'left' } },
  })
  const updateCanvas = vi.fn(async (id: number, body: unknown) => {
    const { data: storedData } = deserialize(serialize(body))
    return { ok: true, result: { id, data: storedData } }
  })
  vi.stubGlobal('guguDesktop', { updateCanvas })

  try {
    const updated = await desktopData.updateCanvas(3, { data })
    expect(updated).toMatchObject({ id: 3, data })
  } finally {
    vi.unstubAllGlobals()
  }
})
