import { _electron as electron } from 'playwright'
import { expect } from 'playwright/test'
import type { ElectronApplication } from 'playwright'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const desktop = resolve(fileURLToPath(new URL('../', import.meta.url)))
const require = createRequire(import.meta.url)
const appIndex = process.argv.indexOf('--app'),
  executable = appIndex >= 0 ? process.argv[appIndex + 1] : undefined
if (appIndex >= 0 && (!executable || !existsSync(executable)))
  throw new Error('打包应用路径无效')
const temporary = mkdtempSync(join(tmpdir(), 'gugu-electron-smoke-'))
writeFileSync(join(temporary, '.gugu-smoke'), 'gugu-desktop-smoke-v1')
let isolatedExecutable: string | undefined
if (executable) {
  const source = resolve(executable)
  if (process.platform === 'darwin') {
    const application = resolve(source, '../../..')
    if (!application.endsWith('.app')) throw new Error('macOS 应用目录无效')
    cpSync(application, join(temporary, 'application.app'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    isolatedExecutable = join(
      temporary,
      'application.app/Contents/MacOS',
      source.split('/').at(-1)!,
    )
  } else {
    cpSync(dirname(source), join(temporary, 'application'), {
      recursive: true,
      verbatimSymlinks: true,
    })
    isolatedExecutable = join(
      temporary,
      'application',
      source.slice(dirname(source).length + 1),
    )
  }
}
let application: ElectronApplication | undefined
const failures: string[] = []
async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(entry[0]),
    ),
  )
  env.GUGU_DESKTOP_TEST_DIRECTORY = temporary
  // 证明运行时不依赖系统 Node/Python，也不借用开发 PATH。
  env.PATH =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      : '/usr/bin:/bin'
  application = await electron.launch({
    executablePath: isolatedExecutable ?? require('electron'),
    args: isolatedExecutable ? ['--smoke'] : [desktop, '--smoke'],
    env,
    timeout: 45_000,
  })
  const page = await application.firstWindow({ timeout: 30_000 })
  page.on('pageerror', () => failures.push('renderer-error'))
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) failures.push('unexpected-network')
  })
  await expect(page.getByText('Core 已连接', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  return page
}
try {
  const page = await launch()
  await expect(page.getByRole('heading', { name: '本地工作台' })).toBeVisible()
  const boundary = await page.evaluate(() => ({
    node: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    bridge: Object.keys(
      (globalThis as Record<string, unknown>).guguDesktop as object,
    ).sort(),
  }))
  expect(boundary).toEqual({
    node: 'undefined',
    process: 'undefined',
    bridge: [
      'clients',
      'createClient',
      'createProject',
      'projects',
      'receipt',
      'sandboxStatus',
    ],
  })
  await page.getByRole('textbox', { name: '项目名称' }).fill('本地回归项目😀')
  await page.getByRole('button', { name: '创建项目', exact: true }).click()
  await expect(page.getByText('本地回归项目😀', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '联系人名称' }).fill('合成联系人小北')
  await page.getByRole('button', { name: '添加联系人', exact: true }).click()
  await expect(page.getByText('合成联系人小北', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.open('https://example.invalid/')
  })
  expect(application!.windows()).toHaveLength(1)
  mkdirSync(join(desktop, '.tools'), { recursive: true })
  await page.screenshot({ path: join(desktop, '.tools/electron-smoke.png') })
  await application!.close()
  application = undefined
  const coreRequire = createRequire(resolve(desktop, '../gugu-core/package.json')),
    Driver = coreRequire('better-sqlite3')
  const db = new Driver(join(temporary, 'core.db'), { readonly: true })
  let operation: string
  try {
    operation = (
      db
        .prepare(
          "SELECT operation_id FROM core_operation_receipts WHERE method='projects.create'",
        )
        .get() as { operation_id: string }
    ).operation_id
  } finally {
    db.close()
  }
  const reopened = await launch()
  await expect(reopened.getByText('本地回归项目😀', { exact: true })).toBeVisible()
  await expect(reopened.getByText('合成联系人小北', { exact: true })).toBeVisible()
  const receipt = await reopened.evaluate(async (id) => {
    const bridge = (globalThis as Record<string, unknown>).guguDesktop as {
      receipt(id: string): Promise<unknown>
    }
    return bridge.receipt(id)
  }, operation)
  expect(receipt).toMatchObject({
    ok: true,
    result: {
      method: 'projects.create',
      result: { name: '本地回归项目😀', version: 1 },
    },
  })
  expect(failures).toEqual([])
  console.log(
    JSON.stringify({
      status: 'passed',
      packaged: Boolean(executable),
      checks: [
        'renderer-boundary',
        'typed-bridge',
        'project-client-create',
        'navigation-denied',
        'restart-persistence',
        'receipt',
        'isolated-path',
      ],
    }),
  )
} finally {
  await application?.close()
  if (dirname(temporary) !== tmpdir()) throw new Error('冒烟清理范围无效')
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 150,
  })
}
