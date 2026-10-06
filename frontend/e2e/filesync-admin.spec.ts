import { test, expect } from '@playwright/test'

test.use({
  storageState: { cookies: [], origins: [] },
  launchOptions: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {},
  video: 'off',
})

const bindingId = 34
const runId = 'run-fs6-synthetic-0001'

function run(status: string, dryRun = false) {
  return {
    id: runId,
    bindingId,
    userId: 'synthetic-user',
    mode: 'snapshot_diff',
    reason: 'manual',
    status,
    stage: status === 'cancelled' ? 'finished' : 'scanning',
    dryRun,
    allowDelete: false,
    progressCurrent: 3,
    progressTotal: null,
    resultCounts: { scanned: 3, hashed: 1, reused: 2, rejected: 0, created: dryRun ? 1 : 0, updated: 0, conflicts: 0 },
    errorCode: status === 'cancelled' ? 'cancelled' : null,
    pauseReason: null,
    nextRunAt: null,
    cumulativeRuntimeSeconds: 1,
    createdAt: '2026-10-06T00:00:00Z',
    startedAt: '2026-10-06T00:00:01Z',
    finishedAt: status === 'cancelled' || status === 'succeeded' ? '2026-10-06T00:00:02Z' : null,
  }
}

test('管理员文件同步：预览无副作用、差异对账需确认且任务可取消', async ({ page }) => {
  const requests = { previews: 0, reconciles: 0, cancels: 0, unbinds: 0 }
  let bindingStatus = 'active'

  await page.addInitScript(() => localStorage.setItem('admin_token', 'synthetic-e2e-token'))
  await page.route('**/api/v1/admin/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/admin/auth/me') {
      await route.fulfill({ json: { username: 'synthetic-admin', role: 'admin' } })
      return
    }
    if (url.pathname === '/api/v1/admin/filesync/status' && request.method() === 'GET') {
      await route.fulfill({ json: {
      featureEnabled: true,
      backgroundReconcileEnabled: true,
        storageBackend: 'local',
        supported: true,
        workspaceShellSupported: true,
        ignoredBindingCount: 0,
        bindings: [{
          id: bindingId,
          userId: 'synthetic-user',
          source: 'workspace_directory',
          mode: 'bidirectional',
          status: bindingStatus,
          protocolVersion: 1,
          rootPath: '/workspace/synthetic',
          revision: 2,
          lastReconciledAt: null,
          updatedAt: null,
          pendingJournal: 1,
          failedJournal: 0,
          rejectedJournal: 0,
          pendingConflicts: 0,
          baselineGeneration: null,
          lastDailyReconciledAt: null,
          lastIntegrityVerifiedAt: null,
          nextReconcileAt: null,
          consecutiveFailures: 0,
        }],
        conflicts: [],
        reconcileRuns: [],
        userScanStates: [],
        failures: [],
        totals: { bindings: 1, journals: 1, pendingJournals: 1, failedJournals: 0, rejectedJournals: 0, pendingConflicts: 0, pendingOutbox: 0 },
        generatedAt: '2026-10-06T00:00:00Z',
      } })
      return
    }
    if (url.pathname === `/api/v1/admin/filesync/bindings/${bindingId}/dry-run` && request.method() === 'POST') {
      requests.previews += 1
      await route.fulfill({ json: run('succeeded', true) })
      return
    }
    if (url.pathname === `/api/v1/admin/filesync/bindings/${bindingId}/reconcile` && request.method() === 'POST') {
      requests.reconciles += 1
      await route.fulfill({ json: run('running') })
      return
    }
    if (url.pathname === `/api/v1/admin/filesync/runs/${runId}/cancel` && request.method() === 'POST') {
      requests.cancels += 1
      await route.fulfill({ json: run('cancelled') })
      return
    }
    if (url.pathname === `/api/v1/admin/filesync/bindings/${bindingId}` && request.method() === 'DELETE') {
      requests.unbinds += 1
      bindingStatus = 'inactive'
      await route.fulfill({ json: { id: bindingId, status: bindingStatus, scopeRevision: 3 } })
      return
    }
    await route.continue()
  })

  await page.goto('/admin/storage-audit')
  await expect(page.getByText('文件同步运行状态')).toBeVisible()
  await expect(page.getByText('#34 · bidirectional')).toBeVisible()

  await page.getByRole('button', { name: '预览' }).click()
  await expect.poll(() => requests.previews).toBe(1)
  await expect(page.locator('.fs-result')).toContainText('预览：扫描 3 项，新增 1')
  expect(requests.reconciles).toBe(0)

  await page.getByRole('button', { name: '执行差异对账' }).click()
  const confirmDialog = page.locator('.confirm-dialog')
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: '取消' }).click()
  await expect(confirmDialog).toBeHidden()
  expect(requests.reconciles).toBe(0)

  await page.getByRole('button', { name: '执行差异对账' }).click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
  await page.locator('.confirm-dialog-confirm').click()
  await expect.poll(() => requests.reconciles).toBe(1)
  await expect(page.getByText(/任务 run-fs6-/)).toContainText('运行中')

  await page.getByRole('button', { name: '取消任务' }).click()
  await expect.poll(() => requests.cancels).toBe(1)
  const jobs = page.locator('.fs-block').filter({ hasText: '最近对账任务' })
  await expect(jobs.locator('.fs-row')).toContainText('已取消')
  await expect(page.getByRole('button', { name: '取消任务' })).toHaveCount(0)

  await page.getByRole('button', { name: '解绑' }).click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
  await expect(page.locator('.confirm-dialog')).toContainText('已同步到文件库的文件和历史记录会保留')
  await page.locator('.confirm-dialog-confirm').click()
  await expect.poll(() => requests.unbinds).toBe(1)
  const bindingRow = page.locator('.fs-row').filter({ hasText: `#${bindingId} · bidirectional` })
  await expect(bindingRow).toContainText('已解绑')
  await expect(page.getByRole('button', { name: '解绑' })).toHaveCount(0)
})
