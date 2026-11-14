import { test, expect, type Page, type Locator } from '@playwright/test'
import { dragOnto } from './fixtures/runtimeDrag'

// 项目文件区 Runtime 拖拽仍需验证真实指针交互与落点生命周期，暂不列入稳定 CI。
test.describe.configure({ mode: 'serial' })

const multiSelectModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const createdFileIds = new Set<number>()
const createdFolderIds = new Set<number>()
const createdProjectIds = new Set<number>()

test.afterEach(async ({ page }) => {
  const fileIds = [...createdFileIds]
  const folderIds = [...createdFolderIds].reverse()
  const projectIds = [...createdProjectIds]
  createdFileIds.clear()
  createdFolderIds.clear()
  createdProjectIds.clear()
  if (!fileIds.length && !folderIds.length && !projectIds.length) return
  await page.evaluate(async ({ fileIds, folderIds, projectIds }) => {
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const headers = { 'X-CSRF-Token': csrfToken }
    for (const id of fileIds) await fetch(`/api/v1/files/${id}`, { method: 'DELETE', headers })
    for (const id of folderIds) await fetch(`/api/v1/folders/${id}`, { method: 'DELETE', headers })
    for (const id of projectIds) await fetch(`/api/v1/projects/${id}`, { method: 'DELETE', headers })
  }, { fileIds, folderIds, projectIds })
})


async function createFolder(root: Locator, name: string) {
  await root.locator('button', { hasText: '新建文件夹' }).click()
  await root.locator('.new-folder-input').fill(name)
  const createdResponse = root.page().waitForResponse(response =>
    response.request().method() === 'POST' && /\/api\/v1\/folders(?:\?|$)/.test(response.url()),
  )
  await root.getByRole('button', { name: '确定' }).click()
  const response = await createdResponse
  expect(response.ok()).toBeTruthy()
  const created = await response.json() as { id: number }
  const card = root.locator('.folder-card', { hasText: name })
  await expect(card).toBeVisible({ timeout: 10000 })
  expect(Number.isInteger(created.id)).toBeTruthy()
  createdFolderIds.add(created.id)
  return created.id
}

async function waitForMoveRuntime(page: Page) {
  await expect(page.locator('[data-runtime-proxy-content="true"]')).toHaveCount(0, { timeout: 5000 })
}

async function openFixtureProject(page: Page): Promise<{ root: Locator; name: string; projectId: number }> {
  await page.goto('/projects')
  const name = `e2e-drag-project-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const projectId = await page.evaluate(async projectName => {
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
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
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const form = new FormData()
    form.append('file', new File(['drag e2e fixture'], `${name}.txt`, { type: 'text/plain' }))
    form.append('space', 'project')
    form.append('project_id', String(projectId))
    const response = await fetch('/api/v1/files', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: form,
    })
    if (!response.ok) throw new Error(`创建拖拽测试文件失败：${response.status} ${await response.text()}`)
    return await response.json() as { id: number; displayName: string; projectId: number | null; folderId: number | null }
  }, { projectId, name })
  expect(created).toMatchObject({ displayName: name, projectId, folderId: null })
  createdFileIds.add(created.id)
}

async function waitForProjectFiles(page: Page, projectId: number, folderId: number, ...names: string[]) {
  await expect.poll(async () => page.evaluate(async ({ projectId, folderId, names }) => {
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const headers = { 'X-CSRF-Token': csrfToken }
    const params = new URLSearchParams({
      space: 'project',
      project_id: String(projectId),
      folder_id: String(folderId),
      limit: '200',
      sort_by: 'id',
      sort_order: 'asc',
    })
    const response = await fetch(`/api/v1/files?${params}`, { headers })
    if (!response.ok) return false
    const page = await response.json()
    const files = Array.isArray(page) ? page : (page.items ?? [])
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
    const targetFolderId = await createFolder(fixture.root, folderName)
    await createProjectFile(page, fixture.projectId, fileName)
    const root = await reopenFixtureProject(page, fixture.name)
    const card = root.locator('.fc-card', { hasText: fileName })
    const target = root.locator('.folder-card', { hasText: folderName })
    await dragOnto(page, card, target)
    await waitForMoveRuntime(page)
    await waitForProjectFiles(page, fixture.projectId, targetFolderId, fileName)
    await target.click()
    await expect(root.locator('.fc-card', { hasText: fileName })).toBeVisible({ timeout: 10000 })
  })

  test('多选拖入文件夹后两个文件都归属目标文件夹', async ({ page }) => {
    const fixture = await openFixtureProject(page)
    const folderName = `e2e-pmmulti-target-${Date.now()}`
    const nameA = `e2e-pma-${Date.now()}`
    const nameB = `e2e-pmb-${Date.now()}`
    const targetFolderId = await createFolder(fixture.root, folderName)
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
    await waitForProjectFiles(page, fixture.projectId, targetFolderId, nameA, nameB)
    await target.click()
    await expect(root.locator('.fc-card', { hasText: nameA })).toBeVisible({ timeout: 10000 })
    await expect(root.locator('.fc-card', { hasText: nameB })).toBeVisible({ timeout: 10000 })
  })
})
