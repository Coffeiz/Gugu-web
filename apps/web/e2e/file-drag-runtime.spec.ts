import { test, expect, type Page, type Locator } from '@playwright/test'
import { dragOnto } from './fixtures/runtimeDrag'

/**
 * 文件/文件夹拖拽移动的 e2e 覆盖（Interaction Runtime Core 接入后，见
 * docs/refactor/文件系统Interaction Runtime Core重构方案.md）。这套交互此前完全没有
 * e2e 覆盖——重构把单卡拖拽从手写的 document.elementFromPoint 命中测试改成了
 * runtime.objects/surfaces/targets/onAction，行为正确性只能靠真实指针事件序列验证，
 * 单测/类型检查覆盖不到。
 *
 * 拖拽用原始 page.mouse.move/down/up 序列模拟指针轨迹（pointerdown 起步、越过阈值、
 * 移到落点、松手），不用 Playwright 的 dragTo（那是 HTML5 dragstart/drop 事件，这里的
 * 卡片走的是 pointer capture 自建拖拽，两套事件模型不一样，dragTo 触发不了）。
 */

// 这几个 describe 都在同一个共享测试账号的「个人文件」根目录（或同一个项目）下建文件夹/传
// 文件，并行 worker 同时跑会互相抢同一份目录内容——Phase 4 的 Collection Presence 让卡片
// 列表随时都可能因为"另一个测试"的增删而重排，导致 boundingBox 在 mouse.move 到落点之前就
// 过期。串行执行，不并发抢同一个目录。
test.describe.configure({ mode: 'serial' })

const multiSelectModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const createdFileIds = new Set<number>()
const createdFolderIds = new Set<number>()

test.afterEach(async ({ page }) => {
  const fileIds = [...createdFileIds]
  const folderIds = [...createdFolderIds].reverse()
  createdFileIds.clear()
  createdFolderIds.clear()
  if (!fileIds.length && !folderIds.length) return
  await page.evaluate(async ({ fileIds, folderIds }) => {
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const headers = { 'X-CSRF-Token': csrfToken }
    for (const fileId of fileIds) {
      await fetch(`/api/v1/files/${fileId}`, { method: 'DELETE', headers })
    }
    // 从内向外删除；不依赖已移除的全量文件/文件夹接口。
    for (const folderId of folderIds) {
      await fetch(`/api/v1/folders/${folderId}`, { method: 'DELETE', headers })
    }
  }, { fileIds, folderIds })
})


async function createFolder(root: Locator, name: string) {
  const createResponse = root.page().waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/folders',
  )
  await root.locator('button', { hasText: '新建文件夹' }).click()
  await root.locator('.new-folder-input').fill(name)
  await root.getByRole('button', { name: '确定' }).click()
  const response = await createResponse
  const created = await response.json() as { id?: number; detail?: string }
  expect(response.status(), created.detail ?? `新建文件夹返回 ${response.status()}`).toBe(201)
  expect(Number.isInteger(created.id)).toBeTruthy()
  createdFolderIds.add(created.id!)
  const card = root.locator('.folder-card', { hasText: name })
  await expect(card).toBeVisible({ timeout: 10000 })
  const folderId = Number(await card.getAttribute('data-folder-id'))
  expect(folderId).toBe(created.id)
}

async function enterFolder(root: Locator, name: string) {
  await root.locator('.folder-card', { hasText: name }).click()
  await expect(root.locator('.bc-item.active, .bc-cur', { hasText: name })).toBeVisible({ timeout: 10000 })
}

async function uploadTextFile(root: Locator, name: string) {
  await root.locator('.fub input[type="file"]').setInputFiles({
    name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from('drag e2e fixture'),
  })
  const card = root.locator('.fc-card', { hasText: name })
  await expect(card).toBeVisible({ timeout: 15000 })
  const fileId = Number(await card.getAttribute('data-file-id'))
  expect(Number.isInteger(fileId)).toBeTruthy()
  createdFileIds.add(fileId)
}

function waitForMovedFiles(page: Page, fileIds: number[], targetFolderId: number) {
  // PATCH 返回时服务端事务已提交；直接核对每个响应，避免刷新路由后再用
  // 另一个 GET 竞态判断持久化状态。
  return Promise.all(fileIds.map(async fileId => {
    const response = await page.waitForResponse(candidate =>
      candidate.request().method() === 'PATCH'
      && new URL(candidate.url()).pathname === `/api/v1/files/${fileId}`,
    )
    const file = await response.json() as { id?: number; folderId?: number | null; detail?: string }
    expect(response.status(), file.detail ?? `文件 ${fileId} 移动接口返回失败`).toBe(200)
    expect(file.id).toBe(fileId)
    expect(file.folderId).toBe(targetFolderId)
    const stored = await page.evaluate(async ({ fileId, targetFolderId }) => {
      const [detailResponse, listingResponse] = await Promise.all([
        fetch(`/api/v1/files/${fileId}`),
        fetch(`/api/v1/files?space=personal&folder_id=${targetFolderId}&sort_by=name&sort_order=asc`),
      ])
      const detail = detailResponse.ok ? await detailResponse.json() : null
      const listing = listingResponse.ok ? await listingResponse.json() : null
      return {
        detailStatus: detailResponse.status,
        listingStatus: listingResponse.status,
        folderId: detail?.folderId ?? null,
        isListed: Array.isArray(listing?.items) && listing.items.some((item: { id?: number }) => item.id === fileId),
      }
    }, { fileId, targetFolderId })
    expect(stored.detailStatus).toBe(200)
    expect(stored.folderId).toBe(targetFolderId)
    expect(stored.listingStatus).toBe(200)
    expect(stored.isListed).toBe(true)
  }))
}

async function waitForMoveRuntime(page: Page) {
  // API 响应先于 Runtime 的视觉事务收尾。等拖拽代理实际释放，避免紧随其后的
  // 目标点击被导航保护误判为仍处于拖拽中；等待 DOM 状态而不是估算动画时长。
  await expect(page.locator('[data-runtime-proxy-content="true"]')).toHaveCount(0, {
    timeout: 5000,
  })
}

test.describe('文件库：单文件拖拽（Runtime Core API）', () => {
  test('单文件拖入文件夹', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()

    const root = page.locator('.files-page')
    const workspaceName = `e2e-drag-root-${Date.now()}`
    const folderName = `e2e-drag-target-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)

    const baseName = `e2e-dragfile-${Date.now()}`
    await uploadTextFile(root, baseName)

    const card = root.locator('.fc-card', { hasText: baseName })
    const target = root.locator('.folder-card', { hasText: folderName })
    const fileId = Number(await card.getAttribute('data-file-id'))
    const targetFolderId = Number(await target.getAttribute('data-folder-id'))
    expect(Number.isInteger(fileId)).toBeTruthy()
    expect(Number.isInteger(targetFolderId)).toBeTruthy()
    const moveResponse = waitForMovedFiles(page, [fileId], targetFolderId)
    await dragOnto(page, card, target)
    await moveResponse

    await expect(root.locator('.fc-card', { hasText: baseName })).toHaveCount(0, { timeout: 10000 })
    await waitForMoveRuntime(page)
    await target.click()
    await expect(root.locator('.bc-item.active, .bc-cur', { hasText: folderName })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: baseName })).toBeVisible({ timeout: 10000 })
  })

  test('单文件拖到面包屑返回上一层', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()

    const folderName = `e2e-bc-${Date.now()}`
    await createFolder(page.locator('.files-page'), folderName)
    await page.locator('.folder-card', { hasText: folderName }).click()
    await expect(page.locator('.bc-item.active', { hasText: folderName })).toBeVisible()

    const baseName = `e2e-bcfile-${Date.now()}`
    await uploadTextFile(page.locator('.files-page'), baseName)

    const card = page.locator('.fc-card', { hasText: baseName })
    const personalCrumb = page.locator('.bc-item', { hasText: '个人文件' })
    await dragOnto(page, card, personalCrumb)

    await expect(page.locator('.fc-card', { hasText: baseName })).toHaveCount(0, { timeout: 10000 })
    await personalCrumb.click()
    await expect(page.locator('.fc-card', { hasText: baseName })).toBeVisible({ timeout: 10000 })
  })

  test('底部拖拽单卡后文件区仍保持贴底', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()

    const root = page.locator('.files-page')
    const viewport = root.locator('.files-main')
    await uploadTextFile(root, `e2e-bottom-${Date.now()}`)
    const cards = root.locator('.fc-card')

    // 将内容推到真正的滚动底部，覆盖“最后一行卡片被抓起”的边界。
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const source = cards.last()
    const box = await source.boundingBox()
    if (!box) throw new Error('底部文件卡没有可见的 bounding box')

    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    const isAtBottom = () => viewport.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
    )
    expect(await isAtBottom()).toBe(true)

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // 只横向越过抓取阈值，避免触发靠近视口边缘时的自动滚动。
    await page.mouse.move(startX + 8, startY, { steps: 2 })
    const remainsAtBottom = await isAtBottom()
    await page.mouse.up()
    await page.mouse.move(0, 0)

    // detach 源卡会缩短 scrollHeight，浏览器将 scrollTop clamp 到新的最大值；
    // 用户可见契约是视口继续贴住底部，而不是内部 scrollTop 数字保持不变。
    expect(remainsAtBottom).toBe(true)
  })
})

test.describe('文件库：Runtime 多选拖拽', () => {
  test('多选两个文件拖入文件夹，落地后能正常进入目标文件夹', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()

    const root = page.locator('.files-page')
    const workspaceName = `e2e-multi-root-${Date.now()}`
    const folderName = `e2e-multi-target-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)

    const nameA = `e2e-multia-${Date.now()}`
    const nameB = `e2e-multib-${Date.now()}`
    await uploadTextFile(root, nameA)
    await uploadTextFile(root, nameB)

    const cardA = root.locator('.fc-card', { hasText: nameA })
    const cardB = root.locator('.fc-card', { hasText: nameB })
    const fileIdA = Number(await cardA.getAttribute('data-file-id'))
    const fileIdB = Number(await cardB.getAttribute('data-file-id'))
    const target = root.locator('.folder-card', { hasText: folderName })
    const targetFolderId = Number(await target.getAttribute('data-folder-id'))
    expect([fileIdA, fileIdB, targetFolderId].every(Number.isInteger)).toBeTruthy()
    const moveResponses = waitForMovedFiles(page, [fileIdA, fileIdB], targetFolderId)
    await cardA.click({ modifiers: [multiSelectModifier] })
    await cardB.click({ modifiers: [multiSelectModifier] })

    await dragOnto(page, cardA, target, { x: 10, y: 10 })
    await moveResponses

    await expect(root.locator('.fc-card', { hasText: nameA })).toHaveCount(0, { timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toHaveCount(0, { timeout: 10000 })
    await expect(target).toContainText('2 个文件 · 0 个文件夹', { timeout: 10000 })

    // 落地后点文件夹应该正常导航进入，不是切换选中（见 selectModeForced 回归修复）
    await waitForMoveRuntime(page)
    await target.click()
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
  })

  test('文件和文件夹混合多选后拖入文件夹', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    const root = page.locator('.files-page')
    const workspaceName = `e2e-mixed-root-${Date.now()}`
    const targetName = `e2e-mixed-target-${Date.now()}`
    const sourceFolderName = `e2e-mixed-source-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, targetName)
    await createFolder(root, sourceFolderName)
    const fileName = `e2e-mixed-file-${Date.now()}`
    await uploadTextFile(root, fileName)

    const sourceFolder = root.locator('.folder-card', { hasText: sourceFolderName })
    const fileCard = root.locator('.fc-card', { hasText: fileName })
    await sourceFolder.click({ modifiers: [multiSelectModifier] })
    await fileCard.click({ modifiers: [multiSelectModifier] })
    const target = root.locator('.folder-card', { hasText: targetName })
    await dragOnto(page, sourceFolder, target, { x: 10, y: 10 })

    await expect(root.locator('.folder-card', { hasText: sourceFolderName })).toHaveCount(0, { timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: fileName })).toHaveCount(0, { timeout: 10000 })
    await waitForMoveRuntime(page)
    await target.click()
    await page.reload()
    await expect(page.locator('.folder-card', { hasText: sourceFolderName })).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
  })

  async function prepareFailedMove(page: Page, suffix: string) {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    const root = page.locator('.files-page')
    const workspaceName = `e2e-failed-root-${suffix}-${Date.now()}`
    const folderName = `e2e-failed-target-${suffix}-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)
    const fileName = `e2e-failed-file-${suffix}-${Date.now()}`
    await uploadTextFile(root, fileName)
    return {
      root,
      fileName,
      card: root.locator('.fc-card', { hasText: fileName }),
      target: root.locator('.folder-card', { hasText: folderName }),
    }
  }

  async function rejectFileMoves(page: Page, status: 403 | 409) {
    await page.route('**/api/v1/files/*', async route => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ detail: status === 409 ? 'version conflict' : 'forbidden' }),
        })
      } else await route.continue()
    })
  }

  test('单文件移动遇到 409 时回滚缓存和页面', async ({ page }) => {
    const { root, fileName, card, target } = await prepareFailedMove(page, '409')
    await rejectFileMoves(page, 409)
    await dragOnto(page, card, target)
    await expect(root.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
    await expect(target).toContainText('0 个文件 · 0 个文件夹', { timeout: 10000 })
  })

  test('单文件移动被权限拒绝时回滚缓存和页面', async ({ page }) => {
    const { root, fileName, card, target } = await prepareFailedMove(page, '403')
    await rejectFileMoves(page, 403)
    await dragOnto(page, card, target)
    await expect(root.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
    await expect(target).toContainText('0 个文件 · 0 个文件夹', { timeout: 10000 })
  })

  test('多文件移动部分失败时整体回滚', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    const root = page.locator('.files-page')
    const workspaceName = `e2e-failed-group-${Date.now()}`
    const folderName = `e2e-failed-group-target-${Date.now()}`
    await createFolder(root, workspaceName)
    const sourceFolderId = Number(await root.locator('.folder-card', { hasText: workspaceName }).getAttribute('data-folder-id'))
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)
    const nameA = `e2e-failed-a-${Date.now()}`
    const nameB = `e2e-failed-b-${Date.now()}`
    await uploadTextFile(root, nameA)
    await uploadTextFile(root, nameB)
    const cardA = root.locator('.fc-card', { hasText: nameA })
    const cardB = root.locator('.fc-card', { hasText: nameB })
    const fileIdA = Number(await cardA.getAttribute('data-file-id'))
    const fileIdB = Number(await cardB.getAttribute('data-file-id'))
    const target = root.locator('.folder-card', { hasText: folderName })
    const targetFolderId = Number(await target.getAttribute('data-folder-id'))
    expect([sourceFolderId, fileIdA, fileIdB, targetFolderId].every(Number.isInteger)).toBeTruthy()
    await cardA.click({ modifiers: [multiSelectModifier] })
    await cardB.click({ modifiers: [multiSelectModifier] })
    let moveCount = 0
    await page.route('**/api/v1/files/*', async route => {
      if (route.request().method() === 'PATCH') {
        moveCount += 1
        if (moveCount === 2) {
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'version conflict' }) })
          return
        }
      }
      await route.continue()
    })
    await dragOnto(page, cardA, target, { x: 10, y: 10 })
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
    await expect(target).toContainText('0 个文件 · 0 个文件夹', { timeout: 10000 })
    await page.reload()
    const persisted = await page.evaluate(async ({ fileIds, sourceFolderId, targetFolderId }) => {
      const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
      const headers = { 'X-CSRF-Token': csrfToken }
      const [targetResponse, ...fileResponses] = await Promise.all([
        fetch(`/api/v1/folders/${targetFolderId}`, { headers }),
        ...fileIds.map(fileId => fetch(`/api/v1/files/${fileId}`, { headers })),
      ])
      if (!targetResponse.ok || fileResponses.some(response => !response.ok)) return null
      const target = await targetResponse.json()
      const files = await Promise.all(fileResponses.map(response => response.json()))
      return {
        targetFileCount: target.fileCount,
        sourceFolderIds: files.map((file: { folderId: number | null }) => file.folderId),
      }
    }, { fileIds: [fileIdA, fileIdB], sourceFolderId, targetFolderId })
    expect(persisted).not.toBeNull()
    expect(persisted?.targetFileCount).toBe(0)
    expect(persisted?.sourceFolderIds).toEqual([sourceFolderId, sourceFolderId])
  })
})
