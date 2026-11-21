import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, readdir } from 'node:fs/promises'
import { resolve, join, relative, sep, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  DESKTOP_METHODS,
  DESKTOP_MUTATIONS,
  MAX_FRAME,
  MAX_AGENT_RESPONSE,
  CHUNKED_AGENT_METHODS,
  CORE_SCHEMA_VERSION,
} from '@gugu/core/desktop'
import type { DesktopReply } from '@gugu/core/desktop'
import { operationSchema } from '@gugu/core'

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
  workerEntry?: string
  agentRuntimeModule?: string
  executable: string
  files: Record<string, string>
}
export async function verifyArtifact(
  directory: string,
): Promise<{ node: string; entry: string; workerEntry: string; agentRuntimeModule: string; manifest: Manifest }> {
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
    manifest.schema !== CORE_SCHEMA_VERSION ||
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
  const workerEntry = manifest.workerEntry ?? 'host/dist/runtime/worker.js'
  const agentRuntimeModule = manifest.agentRuntimeModule
  if (workerEntry !== 'host/dist/runtime/worker.js' && workerEntry !== 'host/desktop-agent-worker.mjs')
    throw new DesktopError('artifact_invalid', 'Node 制品的桌面 Worker 入口无效')
  if (agentRuntimeModule !== 'host/agent/runtime.mjs')
    throw new DesktopError('artifact_invalid', 'Node 制品的桌面 Agent 运行模块无效')
  for (const required of [executable, manifest.entry, workerEntry, agentRuntimeModule])
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
    workerEntry: join(root, workerEntry),
    agentRuntimeModule: join(root, agentRuntimeModule),
    manifest,
  }
}

interface Waiting {
  chunkId?: number
  chunks: Buffer[]
  size: number
  resolve(value: Record<string, unknown>): void
  reject(error: DesktopError): void
  timer: ReturnType<typeof setTimeout>
}
export type DesktopCoreHostRequest = {
  readonly id: number
  readonly signal: AbortSignal
  readonly method: string
  readonly params: Record<string, unknown>
}
type DesktopCoreHostRequestHandler = (request: DesktopCoreHostRequest) => Promise<unknown>
export class CoreHost {
  private agentRunListeners = new Set<(sessionId: number, runId: string) => void>()
  private hostControllers = new Map<number, AbortController>()
  private hostRequestHandler?: DesktopCoreHostRequestHandler
  private waiting?: Waiting
  private buffered = Buffer.alloc(0)
  private tail: Promise<unknown> = Promise.resolve()
  private count = 0
  private sequence = 0
  private healthy = true
  private agentChunksAvailable = false
  private undoAvailable = false
  private calendarAvailable = false
  private notesAvailable = false
  private canvasesAvailable = false
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
    memoryRoot?: string,
    workerEntry?: string,
    agentRuntimeModule?: string,
  ): Promise<CoreHost> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(
            key,
          ),
      ),
    )
    delete env.GUGU_DESKTOP_MEMORY_ROOT
    if (memoryRoot) env.GUGU_DESKTOP_MEMORY_ROOT = memoryRoot
    const child = spawn(node, [entry, '--database', database, '--protocol', '2',
      ...(workerEntry ? ['--worker-entry', workerEntry] : []),
      ...(agentRuntimeModule ? ['--agent-runtime-module', agentRuntimeModule] : [])], {
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
          '本地数据库与当前版本不兼容，请使用新数据库文件',
        )
      if (
        ready.v !== 2 ||
        ready.event !== 'ready' ||
        ready.schema !== String(CORE_SCHEMA_VERSION) ||
        !Array.isArray(ready.capabilities) ||
        !ready.capabilities.includes('operation_receipts') ||
        (manifest &&
          (ready.nodeVersion !== manifest.nodeVersion ||
            ready.nodeAbi !== manifest.nodeAbi))
      )
        throw new DesktopError('startup_failed', 'Core 数据库或运行时无法通过启动校验')
      host.agentChunksAvailable = ready.capabilities.includes('agent_response_chunks_v1')
      host.undoAvailable = ready.capabilities.includes('undo_mind_v1')
      host.calendarAvailable = ready.capabilities.includes('calendar_v1')
      host.notesAvailable = ready.capabilities.includes('mind_notes_v1')
      host.canvasesAvailable = ready.capabilities.includes('mind_canvases_v1')
      return host
    } catch (error) {
      host.fail()
      throw error
    }
  }
  private fail() {
    for (const controller of this.hostControllers.values()) controller.abort()
    this.hostControllers.clear()
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
      if (end + 1 > MAX_FRAME) {
        this.fail()
        return
      }
      const bytes = this.buffered.subarray(0, end)
      this.buffered = this.buffered.subarray(end + 1)
      try {
        const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error()
        const message = frame as Record<string, unknown>
        if (message.v === 2 && message.event === 'agent_run_changed'
          && typeof message.sessionId === 'number' && Number.isSafeInteger(message.sessionId) && message.sessionId > 0
          && typeof message.runId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(message.runId)) {
          for (const listener of this.agentRunListeners) listener(message.sessionId, message.runId)
          continue
        }
        if (message.v === 2 && message.event === 'host_cancel' && typeof message.requestId === 'number') {
          this.hostControllers.get(message.requestId)?.abort()
          continue
        }
        if (message.v === 2 && message.event === 'host_request'
          && Number.isSafeInteger(message.requestId) && (message.requestId as number) > 0
          && typeof message.method === 'string' && /^[a-z][A-Za-z0-9_.-]{1,79}$/.test(message.method)
          && message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params)) {
          void this.answerHostRequest(message.requestId as number, message.method,
            message.params as Record<string, unknown>)
          continue
        }
        const waiting = this.waiting
        if (!waiting) throw new Error()
        if (message.event === 'response_chunk') {
          if (message.v !== 2 || waiting.chunkId === undefined || message.id !== waiting.chunkId
            || message.index !== waiting.chunks.length || typeof message.last !== 'boolean' || typeof message.data !== 'string'
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.data)) throw new Error()
          const chunk = Buffer.from(message.data, 'base64')
          if (!chunk.length || chunk.toString('base64') !== message.data) throw new Error()
          waiting.size += chunk.length
          if (waiting.size > MAX_AGENT_RESPONSE) throw new Error()
          waiting.chunks.push(chunk)
          if (!message.last) continue
          const complete = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(waiting.chunks, waiting.size)))
          if (!complete || typeof complete !== 'object' || Array.isArray(complete) || complete.v !== 2
            || complete.id !== waiting.chunkId || !Object.hasOwn(complete, 'result') || Object.hasOwn(complete, 'error')) throw new Error()
          this.waiting = undefined
          clearTimeout(waiting.timer)
          waiting.resolve(complete)
          continue
        }
        if (waiting.chunks.length) throw new Error()
        this.waiting = undefined
        clearTimeout(waiting.timer)
        waiting.resolve(message)
      } catch {
        this.fail()
        return
      }
    }
    if (this.buffered.length >= MAX_FRAME) this.fail()
  }
  private frame(chunkId?: number): Promise<Record<string, unknown>> {
    if (!this.healthy || this.waiting)
      return Promise.reject(new DesktopError('closed', 'Core 已停止，请重新启动应用'))
    return new Promise((resolveFrame, reject) => {
      this.waiting = {
        chunkId, chunks: [], size: 0,
        resolve: resolveFrame,
        reject,
        timer: setTimeout(() => this.fail(), this.timeoutMs),
      }
    })
  }
  onAgentRunChanged(listener: (sessionId: number, runId: string) => void): () => void {
    this.agentRunListeners.add(listener)
    return () => { this.agentRunListeners.delete(listener) }
  }
  setHostRequestHandler(handler: DesktopCoreHostRequestHandler): void {
    if (this.hostRequestHandler) throw new DesktopError('conflict', 'Core 宿主能力处理器已配置')
    this.hostRequestHandler = handler
  }
  private async answerHostRequest(id: number, method: string, params: Record<string, unknown>): Promise<void> {
    const controller = new AbortController()
    this.hostControllers.set(id, controller)
    let response: Record<string, unknown>
    try {
      if (!this.hostRequestHandler) throw new DesktopError('unsupported', '当前桌面未配置此 Agent 宿主能力')
      const result = await this.hostRequestHandler({ id, method, params, signal: controller.signal })
      response = { v: 2, event: 'host_response', requestId: id, result }
    } catch (error) {
      const code = error instanceof DesktopError && ['invalid_request', 'not_found', 'conflict', 'storage_error', 'closed', 'cancelled', 'busy'].includes(error.code)
        ? error.code : 'storage_error'
      const message = error instanceof DesktopError && code !== 'storage_error'
        ? error.message : '桌面 Agent 宿主能力执行失败'
      response = { v: 2, event: 'host_response', requestId: id, error: { code, message } }
    }
    this.hostControllers.delete(id)
    if (controller.signal.aborted) return
    let line: string
    try {
      line = JSON.stringify(response) + '\n'
      if (Buffer.byteLength(line) > MAX_FRAME) throw new Error()
    } catch {
      line = JSON.stringify({ v: 2, event: 'host_response', requestId: id,
        error: { code: 'invalid_request', message: '桌面 Agent 宿主响应超出长度限制' } }) + '\n'
    }
    if (!this.healthy || !this.child.stdin.write(line)) return
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, callerOperationId?: string): Promise<T> {
    if (this.closing || !this.healthy)
      return Promise.reject(new DesktopError('closed', 'Core 已停止，请重新启动应用'))
    const undoWrite = method === 'undo.apply' || method === 'undo.redo'
    const undoMethod = undoWrite || method === 'undo.preview'
    const calendarMethod = method === 'calendar.list' || method === 'calendar.create' || method === 'calendar.update' || method === 'calendar.delete'
    const notesMethod = method.startsWith('mind.notes.')
    const canvasesMethod = method.startsWith('mind.canvases.')
    if (calendarMethod && !this.calendarAvailable)
      return Promise.reject(new DesktopError('invalid_request', '当前 Core 未提供日历能力'))
    if (notesMethod && !this.notesAvailable)
      return Promise.reject(new DesktopError('invalid_request', '当前 Core 未提供便签能力'))
    if (canvasesMethod && !this.canvasesAvailable)
      return Promise.reject(new DesktopError('invalid_request', '当前 Core 未提供画布能力'))
    if (undoMethod && !this.undoAvailable)
      return Promise.reject(new DesktopError('invalid_request', '当前 Core 未提供撤销能力'))
    if (!(DESKTOP_METHODS as readonly string[]).includes(method) && !undoMethod && !calendarMethod && !notesMethod && !canvasesMethod)
      return Promise.reject(new DesktopError('invalid_request', '此桌面能力不可用'))
    const acceptsOperationId = undoWrite || ['projects.board.create', 'agent.sessions.create', 'agent.sessions.append', 'agent.sessions.rename', 'agent.sessions.delete', 'agent.sessions.queue'].includes(method)
    if ((undoWrite || callerOperationId !== undefined) &&
        (!acceptsOperationId || !operationSchema.safeParse(callerOperationId).success))
      return Promise.reject(new DesktopError('invalid_request', '操作标识无效'))
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      ['owner_id', 'user_id', 'ownerId'].some((key) => key in params)
    )
      return Promise.reject(new DesktopError('invalid_request', '桌面请求无效'))
    const requestLimit = method === 'preferences.desktop.update' ? MAX_FRAME : MAX_FRAME / 2
    let snapshot: Record<string, unknown>
    try {
      const encoded = JSON.stringify(params)
      if (Buffer.byteLength(encoded) > requestLimit - 256) throw new Error()
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
          operationId = callerOperationId ?? (DESKTOP_MUTATIONS.includes(method) || undoWrite ? randomUUID() : undefined)
        const acceptChunks = this.agentChunksAvailable && (CHUNKED_AGENT_METHODS as readonly string[]).includes(method)
        const request =
          JSON.stringify({
            v: 2,
            id,
            method,
            params: snapshot,
            ...(acceptChunks ? { accept_chunks: true } : {}),
            ...(operationId ? { operation_id: operationId } : {}),
          }) + '\n'
        if (Buffer.byteLength(request) > requestLimit)
          throw new DesktopError('invalid_request', '桌面请求超出长度限制')
        let response: Record<string, unknown>
        try {
          const pending = this.frame(acceptChunks ? id : undefined)
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
            schema_upgrade_required: '本地数据库与当前版本不兼容，请使用新数据库文件',
            database_in_use: '数据库正由其他运行时使用，请先关闭其他实例',
            storage_error: '本地数据操作失败，请刷新数据确认状态',
            closed: 'Core 已停止，请重新启动应用',
          }
          if (undoWrite && error.code === 'storage_error')
            throw new DesktopError('unknown_result', '撤销结果未确认，请查询操作收据或重新读取数据，勿重复提交', operationId)
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
