import { test, expect } from '@playwright/test'

test('文件库：进入个人文件目录使用有界分页接口', async ({ page }) => {
  const fileListRequests: string[] = []
  page.on('request', request => {
    if (request.method() !== 'GET') return
    const url = new URL(request.url())
    if (url.pathname === '/api/v1/files/all') fileListRequests.push(url.pathname)
    if (url.pathname === '/api/v1/files') fileListRequests.push(url.pathname + url.search)
  })

  await page.goto('/files')
  await expect(page.locator('.files-page')).toBeVisible()
  const personal = page.locator('.folder-card').filter({ hasText: '个人文件' }).first()
  await expect(personal).toBeVisible()

  const firstPage = page.waitForResponse(response =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/v1/files',
  )
  await personal.click()
  const response = await firstPage
  expect(response.ok()).toBeTruthy()
  const url = new URL(response.url())
  const requestedLimit = url.searchParams.get('limit')
  const limit = requestedLimit == null ? 100 : Number(requestedLimit)
  const payload = await response.json() as { items?: unknown[]; has_more?: boolean }
  expect(limit).toBeGreaterThan(0)
  expect(limit).toBeLessThanOrEqual(200)
  expect(Array.isArray(payload.items)).toBeTruthy()
  expect(payload.items!.length).toBeLessThanOrEqual(limit)
  expect(fileListRequests.some(request => request.startsWith('/api/v1/files/all'))).toBeFalsy()

  if (payload.has_more) {
    const nextPage = page.waitForResponse(next => {
      const nextUrl = new URL(next.url())
      return next.request().method() === 'GET'
        && nextUrl.pathname === '/api/v1/files'
        && nextUrl.searchParams.has('cursor')
    })
    await page.locator('.files-main').evaluate(element => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    const nextResponse = await nextPage
    expect(nextResponse.ok()).toBeTruthy()
    const nextUrl = new URL(nextResponse.url())
    const nextLimit = Number(nextUrl.searchParams.get('limit') ?? 100)
    const nextPayload = await nextResponse.json() as { items?: unknown[] }
    expect(nextUrl.searchParams.get('cursor')).toBeTruthy()
    expect(nextPayload.items!.length).toBeLessThanOrEqual(nextLimit)
  }
})
