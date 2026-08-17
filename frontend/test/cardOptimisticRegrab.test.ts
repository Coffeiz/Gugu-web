import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const projectStore = source('../src/stores/projects.ts')
const mindStore = source('../src/stores/mind.ts')

describe('card optimistic regrab contracts', () => {
  it('项目写入用 queue-time revision 保护最新 move，旧响应只允许推进 version', () => {
    expect(projectStore).toContain('const projectWriteRevisions = new Map<number, number>()')
    expect(projectStore).toContain('const revision = (projectWriteRevisions.get(id) ?? 0) + 1')
    expect(projectStore).toContain('const isLatestIntent = projectWriteRevisions.get(id) === revision')
    expect(projectStore).toContain('if (!isLatestIntent) return')
    expect(projectStore).toContain('current.version = updated.version')
    expect(projectStore).toContain('if (projectWriteRevisions.get(id) === revision) current.doneAt = updated.doneAt')
  })

  it('画布临时卡以 clientKey 保持 Runtime 身份，regrab 不把负 id 发给持久化 API', () => {
    const tempObjectId = mindCanvasObjectId({ nodeId: -7, clientKey: 'optimistic--7' })
    const realObjectId = mindCanvasObjectId({ nodeId: 42, clientKey: 'optimistic--7' })
    expect(tempObjectId).toBe(realObjectId)

    expect(mindStore).toContain('const pendingProjectRefCreates = new Map<number')
    const localOnlyGuard = mindStore.indexOf('if (pendingProjectRefCreates.has(itemId)) return')
    const bringApi = mindStore.indexOf('mindApi.bringCanvasItemToFront(canvasId, itemId, { x, y })')
    expect(localOnlyGuard).toBeGreaterThan(-1)
    expect(bringApi).toBeGreaterThan(localOnlyGuard)

    expect(mindStore).toContain('if (pending) return Promise.resolve()')
    expect(mindStore).toContain('await mindApi.removeCanvasItem(canvasId, created.id)')
  })

  it('抽屉临时卡落库后循环追平 placeholder 最新坐标，不假设只发生一次 regrab', () => {
    expect(mindStore).toContain('while (true)')
    expect(mindStore).toContain('if (current.x === persistedX && current.y === persistedY) break')
    expect(mindStore).toContain('const targetX = current.x')
    expect(mindStore).toContain('const targetY = current.y')
    expect(mindStore).toContain('mindApi.bringCanvasItemToFront(canvasId, created.id, { x: targetX, y: targetY })')
    expect(mindStore).toContain('latestPending.cancelled')
  })
})
