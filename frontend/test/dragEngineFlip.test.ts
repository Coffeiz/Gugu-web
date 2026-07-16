import { describe, expect, it } from 'vitest'
import { collectFlipChildren, prepareFlipTransaction } from '../src/interaction/drag/useDragEngine'

const rect = (left: number, top: number): DOMRect => ({
  left, top, width: 40, height: 20, right: left + 40, bottom: top + 20,
  x: left, y: top, toJSON: () => ({}),
} as DOMRect)

describe('拖拽引擎 FLIP 编排', () => {
  it('收集兄弟卡片时排除源元素和拖拽克隆', () => {
    const container = document.createElement('div')
    const source = document.createElement('div')
    const sibling = document.createElement('div')
    const clone = document.createElement('div')
    clone.className = 'phys-drag-clone'
    container.append(source, sibling, clone)

    expect(collectFlipChildren(container, source)).toEqual([sibling])
  })

  it('跨分组收集时使用稳定标识筛选后代元素', () => {
    const container = document.createElement('div')
    const project = document.createElement('div')
    project.dataset.projectId = 'project-1'
    const folder = document.createElement('div')
    folder.dataset.folderKey = 'folder-1'
    const unrelated = document.createElement('div')
    container.append(project, folder, unrelated)

    expect(collectFlipChildren(container, null, true)).toEqual([project, folder])
  })

  it('engine 准备事务时固定 capture → measure 顺序并交给协调器播放', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const tx = prepareFlipTransaction(
      [{ key: 'card', element }],
      [rect(0, 0)],
      [rect(30, 0)],
      { easing: 'linear' },
    )

    const play = tx.play()
    expect(element.style.transform).toBe('translate(-30.00px, 0.00px)')
    tx.cancel()
    expect(await play).toBe('cancelled')
  })
})
