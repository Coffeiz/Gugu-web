// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  registerObjectType: vi.fn(),
  configureVisual: vi.fn(),
  configureMotion: vi.fn(),
  subscribe: vi.fn(),
}))
vi.mock('@/interaction/runtime/index', () => ({ runtime }))

import { setupInteractionRuntime } from '@/interaction/runtime/setup'
import { MIND_CANVAS_OBJECT_TYPE, MIND_PROJECT_OBJECT_TYPE } from '@/interaction/runtime/canvas'

it('项目跨抽屉落地保留代理卡面，避免把抓取玻璃模糊插值到 none', () => {
  setupInteractionRuntime()
  const definitions = new Map(runtime.registerObjectType.mock.calls)
  expect(definitions.get(MIND_PROJECT_OBJECT_TYPE)).toMatchObject({
    disableTargetVisualMorph: true,
    releaseMode: 'physical',
    motion: { profile: { freeLanding: { duration: 550 } } },
  })
  expect(definitions.get(MIND_CANVAS_OBJECT_TYPE)).toMatchObject({
    disableTargetVisualMorph: false,
  })
})
