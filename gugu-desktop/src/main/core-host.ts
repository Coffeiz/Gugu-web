import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, readdir } from 'node:fs/promises'
import { resolve, join, relative, sep, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  DESKTOP_CHANNELS,
  DESKTOP_METHODS,
  DESKTOP_MUTATIONS,
  MAX_FRAME,
} from '@gugu/core/desktop'
import type { DesktopReply } from '@gugu/core/desktop'

export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly operationId?: string,
  ) {
    super(message)
  }
}
interface Manifest {
  nodeVersion: string
  nodeAbi: string
  entry: string
  executable: string
  files: Record<string, string>
}
export async function verifyArtifact(
  directory: string,
): Promise<{ node: string; entry: string; manifest: Manifest }> {
  const root = await realpath(directory)
  const bytes = await readFile(join(root, 'manifest.json'))
  if (bytes.length > 4 * 1024 * 1024)
    throw new DesktopError('artifact_invalid', 'Node 制品清单无效')
  const manifest = JSON.parse(bytes.toString('utf8'))
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.protocol !== 2 ||
    manifest.schema !== 3 ||
    manifest.coreVersion !== '0.2.0' ||
    !/^26\.(?:1[3-9]|[2-9]\d|\d{3,})\.\d+$/.test(manifest.nodeVersion) ||
    typeof manifest.nodeAbi !== 'string' ||
    !/^\d+$/.test(manifest.nodeAbi) ||
    manifest.executable !== executable ||
    manifest.entry !== 'host/dist/runtime/transport/stdio.js' ||
    !manifest.files ||
    Array.isArray(manifest.files)
  )
    throw new DesktopError('artifact_invalid', 'Node 制品与宿主、协议或数据版本不匹配')
  for (const required of [executable, manifest.entry, 'host/dist/runtime/worker.js'])
    if (!Object.hasOwn(manifest.files, required))
      throw new DesktopError('artifact_invalid', 'Node 制品缺少必要文件')
  const actual = new Set<string>()
  async function inventory(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name)
      if (item.isDirectory()) await inventory(file)
      else if (item.isFile()) actual.add(relative(root, file).split(sep).join('/'))
      else throw new DesktopError('artifact_invalid', 'Node 制品包含链接或特殊资源')
    }
  }
  await inventory(root)
  actual.delete('manifest.json')
  if (actual.size !== Object.keys(manifest.files).length)
    throw new DesktopError('artifact_invalid', 'Node 制品资源集合不匹配')
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (
      name.includes('\\') ||
      name.includes(':') ||
      name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !actual.has(name)
    )
      throw new DesktopError('artifact_invalid', 'Node 制品资源路径或摘要无效')
    const file = await realpath(resolve(root, name))
    if (
      !file.startsWith(root + sep) ||
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex') !== hash
    )
      throw new DesktopError('artifact_invalid', 'Node 制品完整性验证失败')
  }
  return {
    node: join(root, executable),
    entry: join(root, manifest.entry),
    manifest,
  }
}

interface Waiting {
  resolve(value: Record<string, unknown>): void
  reject(error: DesktopError): void
  timer: ReturnType<typeof setTimeout>
}
export class CoreHost {
  private waiting?: Waiting
  private buffered = Buffer.alloc(0)
  private tail: Promise<unknown> = Promise.resolve()
  private count = 0
  private sequence = 0
  private healthy = true
  private closing?: Promise<void>
  private stopped = false
  private constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs = 15_000,
  ) {
    child.stdout.on('data', (chunk) => this.receive(chunk as Buffer))
    child.stderr.resume()
    child.stdin.on('error', () => this.fail())
    child.on('error', () => this.fail())
    child.once('exit', () => {
      this.stopped = true
      this.fail()
    })
  }
  static async launch(
    node: string,
    entry: string,
    database: string,
    manifest?: Pick<Manifest, 'nodeVersion' | 'nodeAbi'>,
    timeoutMs = 15_000,
  ): Promise<CoreHost> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(
            key,
          ),
      ),
    )
    const child = spawn(node, [entry, '--database', database, '--protocol', '2'], {
      cwd: dirname(database),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env,
    })
    const host = new CoreHost(child, timeoutMs)
    try {
      const ready = await host.frame()
      if (ready.error && (ready.error as { code: string }).code === 'database_in_use')
        throw new DesktopError(
          'database_in_use',
          '数据库正由其他运行时使用，请先关闭其他实例',
        )
      if (
        ready.error &&
        (ready.error as { code: string }).code === 'schema_upgrade_required'
      )
        throw new DesktopError(
          'schema_upgrade_required',
          '数据库需要显式备份升级，请先运行 Core migrate',
        )
      if (
        ready.v !== 2 ||
        ready.event !== 'ready' ||
        ready.schema !== '3' ||
        !Array.isArray(ready.capabilities) ||
        !ready.capabilities.includes('operation_receipts') ||
        (manifest &&
          (ready.nodeVersion !== manifest.nodeVersion ||
            ready.nodeAbi !== manifest.nodeAbi))
      )
        throw new DesktopError('startup_failed', 'Core 数据库或运行时无法通过启动校验')
      return host
    } catch (error) {
      host.fail()
      throw error
    }
  }
  private fail() {
    this.healthy = false
    if (!this.stopped) this.child.kill()
    if (this.waiting) {
      const pending = this.waiting
      this.waiting = undefined
      clearTimeout(pending.timer)
      pending.reject(new DesktopError('transport_failed', 'Core 通信中断，请重启应用'))
    }
  }
  private receive(chunk: Buffer) {
    if (!this.healthy) return
    this.buffered = Buffer.concat([this.buffered, chunk])
    let end: number
    while ((end = this.buffered.indexOf(10)) !== -1) {
      if (end + 1 > MAX_FRAME || !this.waiting) {
        this.fail()
        return
      }
      const waiting = this.waiting
      this.waiting = undefined
      clearTimeout(waiting.timer)
      const bytes = this.buffered.subarray(0, end)
      this.buffered = this.buffered.subarray(end + 1)
      try {
        const frame: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        )
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error()
        waiting.resolve(frame as Record<string, unknown>)
      } catch {
        waiting.reject(new DesktopError('invalid_frame', 'Core 响应结构无效，请重启应用'))
        this.fail()
      }
    }
    if (this.buffered.length >= MAX_FRAME) this.fail()
  }
  private frame(): Promise<Record<string, unknown>> {
    if (!this.healthy || this.waiting)
      return Promise.reject(new DesktopError('closed', 'Core 已停止，请重新启动应用'))
    return new Promise((resolveFrame, reject) => {
      this.waiting = {
        resolve: resolveFrame,
        reject,
        timer: setTimeout(() => this.fail(), this.timeoutMs),
      }
    })
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closing || !this.healthy)
      return Promise.reject(new DesktopError('closed', 'Core 已停止，请重新启动应用'))
    if (!(DESKTOP_METHODS as readonly string[]).includes(method))
      return Promise.reject(new DesktopError('invalid_request', '此桌面能力不可用'))
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      ['owner_id', 'user_id', 'ownerId'].some((key) => key in params)
    )
      return Promise.reject(new DesktopError('invalid_request', '桌面请求无效'))
    let snapshot: Record<string, unknown>
    try {
      const encoded = JSON.stringify(params)
      if (Buffer.byteLength(encoded) > MAX_FRAME / 2 - 256) throw new Error()
      snapshot = JSON.parse(encoded)
    } catch {
      return Promise.reject(
        new DesktopError('invalid_request', '桌面请求无法编码或超出长度限制'),
      )
    }
    if (this.count >= 128)
      return Promise.reject(new DesktopError('busy', '桌面请求队列已满'))
    this.count++
    const task = this.tail
      .then(async () => {
        if (!this.healthy) throw new DesktopError('closed', 'Core 已停止，请重新启动应用')
        const id = ++this.sequence,
          operationId = DESKTOP_MUTATIONS.includes(method) ? randomUUID() : undefined
        const request =
          JSON.stringify({
            v: 2,
            id,
            method,
            params: snapshot,
            ...(operationId ? { operation_id: operationId } : {}),
          }) + '\n'
        if (Buffer.byteLength(request) > MAX_FRAME / 2)
          throw new DesktopError('invalid_request', '桌面请求超出长度限制')
        let response: Record<string, unknown>
        try {
          const pending = this.frame()
          this.child.stdin.write(request)
          response = await pending
        } catch {
          throw new DesktopError(
            'unknown_result',
            'Core 通信中断，请重启后读取已保存数据或查询操作收据，勿重复提交',
            operationId,
          )
        }
        if (
          response.v !== 2 ||
          response.id !== id ||
          Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')
        ) {
          this.fail()
          throw new DesktopError(
            'unknown_result',
            'Core 响应无效，请重启后查询操作收据，勿重复提交',
            operationId,
          )
        }
        if (Object.hasOwn(response, 'error')) {
          const error = response.error as { code?: unknown } | null
          if (!error || typeof error.code !== 'string') {
            this.fail()
            throw new DesktopError(
              'unknown_result',
              'Core 响应无效，操作结果未确认',
              operationId,
            )
          }
          const messages: Record<string, string> = {
            conflict: '项目已变化，请刷新后重试',
            not_found: '数据不存在',
            invalid_request: '请求无效，请检查输入',
            busy: '本地数据队列已满，请稍后重试',
            cancelled: '操作已取消',
            result_too_large: '返回结果超出桌面协议限制',
            schema_upgrade_required: '数据库需要升级，请运行 Core migrate',
            database_in_use: '数据库正由其他运行时使用，请先关闭其他实例',
            storage_error: '本地数据操作失败，请刷新数据确认状态',
            closed: 'Core 已停止，请重新启动应用',
          }
          if (Object.hasOwn(messages, error.code))
            throw new DesktopError(error.code, messages[error.code]!, undefined)
          throw new DesktopError(
            'unknown_result',
            '本地数据操作结果未确认，请查询操作收据或读取已保存数据，勿重复提交',
            operationId,
          )
        }
        return response.result as T
      })
      .finally(() => {
        this.count--
      })
    this.tail = task.catch(() => undefined)
    return task
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.tail.then(
      () =>
        new Promise<void>((resolveClose) => {
          if (this.stopped) {
            resolveClose()
            return
          }
          const done = () => {
            clearTimeout(timer)
            resolveClose()
          }
          const timer = setTimeout(() => {
            this.fail()
            done()
          }, 3000)
          this.child.once('exit', done)
          this.child.stdin.end()
        }),
    )
    return this.closing
  }
}

export interface Caller {
  sender: unknown
  senderFrame: unknown
}
export function desktopHandlers(
  host: Pick<CoreHost, 'request'>,
  diagnostics: () => Promise<unknown>,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return {
    [DESKTOP_CHANNELS.projects]: () => host.request('projects.list'),
    [DESKTOP_CHANNELS.createProject]: (name: unknown) =>
      host.request('projects.create', { name }),
    [DESKTOP_CHANNELS.clients]: () => host.request('clients.list'),
    [DESKTOP_CHANNELS.createClient]: (name: unknown) =>
      host.request('clients.create', { name }),
    [DESKTOP_CHANNELS.receipt]: (operation: unknown) =>
      host.request('operations.get', { operation_id: operation }),
    [DESKTOP_CHANNELS.sandboxStatus]: diagnostics,
  }
}
export async function desktopReply<T>(
  trusted: boolean,
  action: () => Promise<T>,
): Promise<DesktopReply<T>> {
  if (!trusted)
    return {
      ok: false,
      error: { code: 'forbidden', message: '此窗口无权使用桌面能力' },
    }
  try {
    return { ok: true, result: await action() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof DesktopError
          ? {
              code: error.code,
              message: error.message,
              ...(error.operationId ? { operationId: error.operationId } : {}),
            }
          : { code: 'failed', message: '本地操作失败，请检查运行时状态' },
    }
  }
}
