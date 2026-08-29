import { test, expect, type Page, type Locator } from '@playwright/test'

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
const createdNames = new Set<string>()

test.afterEach(async ({ page }) => {
  const names = [...createdNames]
  createdNames.clear()
  if (!names.length) return
  await page.evaluate(async (targetNames) => {
    const token = localStorage.getItem('user_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const matches = new Set(targetNames)
    const allFiles = await fetch('/api/v1/files/all', { headers }).then(response => response.ok ? response.json() : [])
    for (const file of allFiles.filter((item: { displayName?: string }) => matches.has(item.displayName))) {
      await fetch(`/api/v1/files/${file.id}`, { method: 'DELETE', headers })
    }
    const allFolders = await fetch('/api/v1/folders/all', { headers }).then(response => response.ok ? response.json() : [])
    // 先删根文件夹；服务端会递归处理子文件夹和文件，子项即使随后返回 404 也不影响清理。
    const folders = allFolders
      .filter((item: { name?: string }) => matches.has(item.name))
      .sort((a: { parentId?: number | null }, b: { parentId?: number | null }) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)))
    for (const folder of folders) {
      await fetch(`/api/v1/folders/${folder.id}`, { method: 'DELETE', headers })
    }
  }, names)
})

async function dragOnto(page: Page, source: Locator, target: Locator, edgeOffset?: { x: number; y: number }) {
  // raw page.mouse.* 不像 locator.click() 那样会自动把元素滚入视口——测试账号的个人文件目录
  // 随着长期跑 e2e 会积累很多历史文件夹/文件，新建的卡片经常落在折叠区以下，不显式滚动的话
  // boundingBox 拿到的是页面坐标，但那块区域可能根本不在当前视口内，鼠标移过去等于移到空白处。
  await source.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('drag source/target 没有可见的 bounding box')
  const startX = from.x + from.width / 2
  const startY = from.y + from.height / 2
  const endX = edgeOffset ? to.x + edgeOffset.x : to.x + to.width / 2
  const endY = edgeOffset ? to.y + edgeOffset.y : to.y + to.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // 先走几步小位移越过 5px 抓取阈值，再移向落点——太快/太少步数有时不会触发 Runtime 的拖拽 session。
  await page.mouse.move(startX + 20, startY + 20, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 15 })
  await page.mouse.up()
  await page.mouse.move(0, 0)
}

async function createFolder(root: Locator, name: string) {
  await root.locator('button', { hasText: '新建文件夹' }).click()
  await root.locator('.new-folder-input').fill(name)
  await root.getByRole('button', { name: '确定' }).click()
  await expect(root.locator('.folder-card', { hasText: name })).toBeVisible({ timeout: 10000 })
  createdNames.add(name)
}

async function enterFolder(root: Locator, name: string) {
  await root.locator('.folder-card', { hasText: name }).click()
  await expect(root.locator('.bc-item.active, .bc-cur', { hasText: name })).toBeVisible({ timeout: 10000 })
}

async function uploadTextFile(root: Locator, name: string) {
  await root.locator('.fub input[type="file"]').setInputFiles({
    name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from('drag e2e fixture'),
  })
  await expect(root.locator('.fc-card', { hasText: name })).toBeVisible({ timeout: 15000 })
  createdNames.add(name)
}

async function waitForMovedFile(page: Page, ...fileNames: string[]) {
  // 拖拽先更新本地缓存，API 提交随后完成；重新加载后再断言，确保验证的是
  // 服务端持久化结果，而不是恰好命中的一次前端乐观状态。
  await page.reload()
  for (const fileName of fileNames) {
    await expect(page.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
  }
}

async function waitForMoveRuntime(page: Page) {
  // API 响应先于 Runtime 的受控对象释放；等一个完整的浏览器渲染周期和
  // Runtime 收尾动画，避免导航保护把紧随其后的目标点击误判为拖拽中的点击。
  await page.waitForTimeout(500)
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
    const moveResponse = page.waitForResponse(response =>
      response.request().method() === 'PATCH' && response.url().includes('/api/v1/files/'))
    await dragOnto(page, card, target)
    await moveResponse

    await expect(root.locator('.fc-card', { hasText: baseName })).toHaveCount(0, { timeout: 10000 })
    await waitForMoveRuntime(page)
    // Runtime pointer 事务收尾期间直接派发语义 click，避免再次走拖拽指针序列；
    // 目录进入仍由文件夹卡片的真实 click handler 完成。
    await target.evaluate(element => (element as HTMLElement).click())
    await waitForMovedFile(page, baseName)
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

  test('底部拖拽单卡不改变文件区滚动位置', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()

    const root = page.locator('.files-page')
    const viewport = root.locator('.files-main')
    const cards = root.locator('.fc-card')
    const cardCount = await cards.count()
    test.skip(cardCount === 0, '没有可拖拽文件卡')

    // 将内容推到真正的滚动底部，覆盖“最后一行卡片被抓起”的边界。
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const source = cards.last()
    const box = await source.boundingBox()
    if (!box) throw new Error('底部文件卡没有可见的 bounding box')

    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    const before = await viewport.evaluate((element) => element.scrollTop)

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    // 只横向越过抓取阈值，避免触发靠近视口边缘时的自动滚动。
    await page.mouse.move(startX + 8, startY, { steps: 2 })
    const during = await viewport.evaluate((element) => element.scrollTop)
    await page.mouse.up()
    await page.mouse.move(0, 0)

    expect(Math.abs(during - before)).toBeLessThanOrEqual(0.1)
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
    await cardA.click({ modifiers: [multiSelectModifier] })
    await cardB.click({ modifiers: [multiSelectModifier] })

    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, cardA, target, { x: 10, y: 10 })

    await expect(root.locator('.fc-card', { hasText: nameA })).toHaveCount(0, { timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toHaveCount(0, { timeout: 10000 })
    await expect(target).toContainText('2 项', { timeout: 10000 })

    // 落地后点文件夹应该正常导航进入，不是切换选中（见 selectModeForced 回归修复）
    await waitForMoveRuntime(page)
    await target.click()
    await waitForMovedFile(page, nameA, nameB)
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
    await expect(target).toContainText('0 项', { timeout: 10000 })
  })

  test('单文件移动被权限拒绝时回滚缓存和页面', async ({ page }) => {
    const { root, fileName, card, target } = await prepareFailedMove(page, '403')
    await rejectFileMoves(page, 403)
    await dragOnto(page, card, target)
    await expect(root.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
    await expect(target).toContainText('0 项', { timeout: 10000 })
  })

  test('多文件移动部分失败时整体回滚', async ({ page }) => {
    await page.goto('/files')
    await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    const root = page.locator('.files-page')
    const workspaceName = `e2e-failed-group-${Date.now()}`
    const folderName = `e2e-failed-group-target-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)
    const nameA = `e2e-failed-a-${Date.now()}`
    const nameB = `e2e-failed-b-${Date.now()}`
    await uploadTextFile(root, nameA)
    await uploadTextFile(root, nameB)
    const cardA = root.locator('.fc-card', { hasText: nameA })
    const cardB = root.locator('.fc-card', { hasText: nameB })
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
    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, cardA, target, { x: 10, y: 10 })
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
    await expect(target).toContainText('0 项', { timeout: 10000 })
  })
})

test.describe('项目文件区：Runtime 拖拽', () => {
  async function openFirstProject(page: Page): Promise<Locator> {
    await page.goto('/projects')
    const project = page.locator('.proj-card').first()
    await project.waitFor({ state: 'visible', timeout: 10000 })
    await project.click()
    const root = page.locator('.project-modal-root')
    await expect(root).toBeVisible()
    await expect(root.locator('.file-browser-panel')).toBeVisible()
    return root
  }

  test('单文件拖入文件夹', async ({ page }) => {
    const root = await openFirstProject(page)
    const workspaceName = `e2e-pm-drag-root-${Date.now()}`
    const folderName = `e2e-pm-drag-target-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)

    const baseName = `e2e-pmfile-${Date.now()}`
    await uploadTextFile(root, baseName)

    const card = root.locator('.fc-card', { hasText: baseName })
    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, card, target)

    await expect(root.locator('.fc-card', { hasText: baseName })).toHaveCount(0, { timeout: 10000 })
    await waitForMoveRuntime(page)
    await target.evaluate(element => (element as HTMLElement).click())
    await expect(root.locator('.fc-card', { hasText: baseName })).toBeVisible({ timeout: 10000 })
  })

  test('多选两个文件拖入文件夹，落地后能正常进入目标文件夹', async ({ page }) => {
    const root = await openFirstProject(page)
    const workspaceName = `e2e-pmmulti-root-${Date.now()}`
    const folderName = `e2e-pmmulti-target-${Date.now()}`
    await createFolder(root, workspaceName)
    await enterFolder(root, workspaceName)
    await createFolder(root, folderName)

    const nameA = `e2e-pma-${Date.now()}`
    const nameB = `e2e-pmb-${Date.now()}`
    await uploadTextFile(root, nameA)
    await uploadTextFile(root, nameB)

    const cardA = root.locator('.fc-card', { hasText: nameA })
    const cardB = root.locator('.fc-card', { hasText: nameB })
    await cardA.click({ modifiers: [multiSelectModifier] })
    await cardB.click({ modifiers: [multiSelectModifier] })

    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, cardA, target, { x: 10, y: 10 })

    await expect(root.locator('.fc-card', { hasText: nameA })).toHaveCount(0, { timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toHaveCount(0, { timeout: 10000 })

    await waitForMoveRuntime(page)
    await target.evaluate(element => (element as HTMLElement).click())
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
  })
})
