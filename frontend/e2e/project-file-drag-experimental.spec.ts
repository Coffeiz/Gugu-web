import { test, expect, type Page, type Locator } from '@playwright/test'

// 项目文件区 Runtime 拖拽仍需验证真实指针交互与落点生命周期，暂不列入稳定 CI。
test.describe.configure({ mode: 'serial' })

const multiSelectModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const createdNames = new Set<string>()
const createdProjectIds = new Set<number>()

test.afterEach(async ({ page }) => {
  const names = [...createdNames]
  const projectIds = [...createdProjectIds]
  createdNames.clear()
  createdProjectIds.clear()
  if (!names.length && !projectIds.length) return
  await page.evaluate(async ({ targetNames, projectIds }) => {
    const token = localStorage.getItem('user_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const matches = new Set(targetNames)
    if (targetNames.length) {
      const allFiles = await fetch('/api/v1/files/all', { headers }).then(response => response.ok ? response.json() : [])
      for (const file of allFiles.filter((item: { displayName?: string }) => matches.has(item.displayName))) {
        await fetch(`/api/v1/files/${file.id}`, { method: 'DELETE', headers })
      }
      const allFolders = await fetch('/api/v1/folders/all', { headers }).then(response => response.ok ? response.json() : [])
      const folders = allFolders
        .filter((item: { name?: string }) => matches.has(item.name))
        .sort((a: { parentId?: number | null }, b: { parentId?: number | null }) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)))
      for (const folder of folders) await fetch(`/api/v1/folders/${folder.id}`, { method: 'DELETE', headers })
    }
    for (const id of projectIds) await fetch(`/api/v1/projects/${id}`, { method: 'DELETE', headers })
  }, { targetNames: names, projectIds })
})

async function dragOnto(page: Page, source: Locator, target: Locator, edgeOffset?: { x: number; y: number }) {
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
  await page.mouse.move(startX + 20, startY + 20, { steps: 5 })
  await page.mouse.move(endX, endY, { steps: 15 })
  await expect(page.locator('[data-runtime-proxy-content="true"]').first()).toBeAttached({ timeout: 5000 })
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

async function waitForMoveRuntime(page: Page) {
  await expect(page.locator('[data-runtime-proxy-content="true"]')).toHaveCount(0, { timeout: 5000 })
}

async function openFixtureProject(page: Page): Promise<{ root: Locator; name: string; projectId: number }> {
  await page.goto('/projects')
  const name = `e2e-drag-project-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const projectId = await page.evaluate(async projectName => {
    const token = localStorage.getItem('user_token')
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name: projectName }),
    })
    if (!response.ok) throw new Error(`创建拖拽测试项目失败：${response.status}`)
    return (await response.json()).id as number
  }, name)
  createdProjectIds.add(projectId)
  await page.reload()
  const project = page.locator('.proj-card').filter({ hasText: name })
  await expect(project).toBeVisible()
  await project.click()
  const root = page.locator('.project-modal-root')
  await expect(root.locator('.file-browser-panel')).toBeVisible()
  return { root, name, projectId }
}

async function reopenFixtureProject(page: Page, name: string): Promise<Locator> {
  await page.reload()
  const project = page.locator('.proj-card').filter({ hasText: name })
  await expect(project).toBeVisible()
  await project.click()
  const root = page.locator('.project-modal-root')
  await expect(root.locator('.file-browser-panel')).toBeVisible()
  return root
}

async function createProjectFile(page: Page, projectId: number, name: string) {
  const created = await page.evaluate(async ({ projectId, name }) => {
    const token = localStorage.getItem('user_token')
    const form = new FormData()
    form.append('file', new File(['drag e2e fixture'], `${name}.txt`, { type: 'text/plain' }))
    form.append('space', 'project')
    form.append('project_id', String(projectId))
    const response = await fetch('/api/v1/files', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    if (!response.ok) throw new Error(`创建拖拽测试文件失败：${response.status} ${await response.text()}`)
    return await response.json() as { displayName: string; projectId: number | null; folderId: number | null }
  }, { projectId, name })
  expect(created).toMatchObject({ displayName: name, projectId, folderId: null })
  createdNames.add(name)
}

async function waitForProjectFiles(page: Page, projectId: number, folderId: number, ...names: string[]) {
  await expect.poll(async () => page.evaluate(async ({ projectId, folderId, names }) => {
    const token = localStorage.getItem('user_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const files = await fetch('/api/v1/files/all', { headers }).then(response => response.ok ? response.json() : [])
    return names.every(name => files.some((file: { displayName?: string; projectId?: number | null; folderId?: number | null }) =>
      file.displayName === name && file.projectId === projectId && file.folderId === folderId,
    ))
  }, { projectId, folderId, names })).toBe(true)
}

test.describe('项目文件区：Runtime 拖拽', () => {
  test('单文件拖入文件夹后能从服务端重新进入目标文件夹', async ({ page }) => {
    const fixture = await openFixtureProject(page)
    const folderName = `e2e-pm-drag-target-${Date.now()}`
    const fileName = `e2e-pmfile-${Date.now()}`
    await createFolder(fixture.root, folderName)
    await createProjectFile(page, fixture.projectId, fileName)
    const root = await reopenFixtureProject(page, fixture.name)
    const card = root.locator('.fc-card', { hasText: fileName })
    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, card, target)
    await waitForMoveRuntime(page)
    const targetFolderId = Number(await target.getAttribute('data-folder-id'))
    await waitForProjectFiles(page, fixture.projectId, targetFolderId, fileName)
    await target.click()
    await expect(root.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
  })

  test('多选拖入文件夹后两个文件都归属目标文件夹', async ({ page }) => {
    const fixture = await openFixtureProject(page)
    const folderName = `e2e-pmmulti-target-${Date.now()}`
    const nameA = `e2e-pma-${Date.now()}`
    const nameB = `e2e-pmb-${Date.now()}`
    await createFolder(fixture.root, folderName)
    await createProjectFile(page, fixture.projectId, nameA)
    await createProjectFile(page, fixture.projectId, nameB)
    const root = await reopenFixtureProject(page, fixture.name)
    const cardA = root.locator('.fc-card', { hasText: nameA })
    const cardB = root.locator('.fc-card', { hasText: nameB })
    await cardA.click({ modifiers: [multiSelectModifier] })
    await cardB.click({ modifiers: [multiSelectModifier] })
    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, cardA, target, { x: 10, y: 10 })
    await waitForMoveRuntime(page)
    const targetFolderId = Number(await target.getAttribute('data-folder-id'))
    await waitForProjectFiles(page, fixture.projectId, targetFolderId, nameA, nameB)
    await target.click()
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
  })
})
