import { describe, expect, it } from 'vitest'
import { collectFlipChildren, prepareSiblingFlip } from '../src/interaction/drag/useDragEngine'

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

  it('engine 准备兄弟事务时固定 capture → 业务变更 → measure 顺序', async () => {
    const element = document.createElement('div')
    const container = document.createElement('div')
    container.appendChild(element)
    document.body.appendChild(container)
    const original = element.getBoundingClientRect
    let moved = false
    element.getBoundingClientRect = () => moved ? rect(30, 0) : rect(0, 0)
    const { transaction: tx } = prepareSiblingFlip(container, null, false, () => { moved = true }, { easing: 'linear' })

    const play = tx.play()
    expect(element.style.transform).toBe('translate(-30.00px, 0.00px)')
    tx.cancel()
    expect(await play).toBe('cancelled')
    element.getBoundingClientRect = original
  })

  it('同一兄弟元素被新事务接管时，旧事务不会覆盖新样式', async () => {
    const container = document.createElement('div')
    const element = document.createElement('div')
    container.appendChild(element)
    document.body.appendChild(container)
    let offset = 0
    element.getBoundingClientRect = () => rect(offset, 0)

    const first = prepareSiblingFlip(container, null, false, () => { offset = 30 }, { easing: 'linear' })
    const firstPlay = first.transaction.play()
    offset = 30
    const second = prepareSiblingFlip(container, null, false, () => { offset = 0 }, { easing: 'linear' })
    const secondPlay = second.transaction.play()

    expect(element.dataset.flipOwner).toBe('coordinator')
    expect(element.style.transform).toBe('translate(30.00px, 0.00px)')
    expect(await firstPlay).toBe('cancelled')
    second.transaction.cancel()
    expect(await secondPlay).toBe('cancelled')
  })

  it('跨列让位时源列和目标列分别创建可取消事务', async () => {
    const source = document.createElement('div')
    const target = document.createElement('div')
    const sourceSibling = document.createElement('div')
    const targetSibling = document.createElement('div')
    source.appendChild(sourceSibling)
    target.appendChild(targetSibling)
    document.body.append(source, target)
    let sourceLeft = 0, targetLeft = 0
    sourceSibling.getBoundingClientRect = () => rect(sourceLeft, 0)
    targetSibling.getBoundingClientRect = () => rect(targetLeft, 0)
    const sourceTx = prepareSiblingFlip(source, null, false, () => { sourceLeft = 20 }, { easing: 'linear' }).transaction
    const targetTx = prepareSiblingFlip(target, null, false, () => { targetLeft = 20 }, { easing: 'linear' }).transaction
    const sourcePlay = sourceTx.play()
    const targetPlay = targetTx.play()
    sourceTx.cancel()
    targetTx.cancel()
    expect(await sourcePlay).toBe('cancelled')
    expect(await targetPlay).toBe('cancelled')
  })

  it('中途重抓时新事务接管旧事务的元素样式', async () => {
    const container = document.createElement('div')
    const element = document.createElement('div')
    container.appendChild(element)
    document.body.appendChild(container)
    let left = 0
    element.getBoundingClientRect = () => rect(left, 0)
    const landing = prepareSiblingFlip(container, null, false, () => { left = 40 }, { easing: 'linear' }).transaction
    const landingPlay = landing.play()
    left = 40
    const regrab = prepareSiblingFlip(container, null, false, () => { left = 80 }, { easing: 'linear' }).transaction
    const regrabPlay = regrab.play()
    expect(await landingPlay).toBe('cancelled')
    regrab.cancel()
    expect(await regrabPlay).toBe('cancelled')
  })
})
