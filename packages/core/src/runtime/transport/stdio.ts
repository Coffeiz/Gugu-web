import { closeDesktopTerminal } from '../desktop-terminal.js'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { CHUNKED_AGENT_METHODS, MAX_AGENT_RESPONSE } from '../../contracts/desktop.js'
import { CoreError } from '../../contracts/index.js'
import { LocalRuntime } from '../local.js'
import {
  MAX_FRAME,
  boundedFrame,
  desktopFrame,
  visibleError as visible,
} from '../commands.js'

const args = process.argv.slice(2),
  databaseIndex = args.indexOf('--database'),
  workerIndex = args.indexOf('--worker-entry'),
  agentRuntimeIndex = args.indexOf('--agent-runtime-module'),
  protocolIndex = args.indexOf('--protocol')
const database = databaseIndex < 0 ? undefined : args[databaseIndex + 1]
const workerEntry = workerIndex < 0 ? undefined : args[workerIndex + 1]
const agentRuntimeModule = agentRuntimeIndex < 0 ? undefined : args[agentRuntimeIndex + 1]
const protocol = protocolIndex < 0 ? 2 : Number(args[protocolIndex + 1])
async function send(value: Record<string, unknown>): Promise<void> {
  const output = boundedFrame(value) + '\n'
  if (!process.stdout.write(output)) await once(process.stdout, 'drain')
}
async function sendResponse(request: unknown, response: Record<string, unknown>) {
  if (protocol === 2 && request && typeof request === 'object' && 'accept_chunks' in request && request.accept_chunks === true
    && 'method' in request && (CHUNKED_AGENT_METHODS as readonly unknown[]).includes(request.method)
    && typeof response.id === 'number' && Object.hasOwn(response, 'result')) {
    const bytes = Buffer.from(JSON.stringify(response))
    if (bytes.length + 1 > MAX_FRAME && bytes.length <= MAX_AGENT_RESPONSE) {
      const chunkBytes = 36_000
      for (let start = 0, index = 0; start < bytes.length; start += chunkBytes, index++) {
        await send({ v: protocol, event: 'response_chunk', id: response.id, index, last: start + chunkBytes >= bytes.length,
          data: bytes.subarray(start, start + chunkBytes).toString('base64') })
      }
      return
    }
  }
  await send(response)
}
async function main(): Promise<number> {
  if (!database || ![1, 2].includes(protocol)
    || workerIndex >= 0 && (!workerEntry || workerEntry.startsWith('--'))
    || agentRuntimeIndex >= 0 && (!agentRuntimeModule || agentRuntimeModule.startsWith('--'))) {
    await send({
      v: 2,
      event: 'failed',
      error: { code: 'invalid_request', message: 'Core 启动参数无效' },
    })
    return 2
  }
  const onWorkerExit = (exitCode: number, reason: string, frames: readonly string[]) => {
    if (protocol === 2) void send({ v: protocol, event: 'core_worker_exit', exitCode, reason, frames }).catch(() => {})
  }
  let runtime: LocalRuntime
  try {
    runtime = await (existsSync(database)
      ? LocalRuntime.open(database, {
          exclusive: true, onWorkerExit,
          ...(workerEntry ? { workerEntry: resolve(workerEntry) } : {}),
        ...(agentRuntimeModule ? { agentRuntimeModule: resolve(agentRuntimeModule) } : {}),
        })
      : LocalRuntime.initialize(database, {
          exclusive: true, onWorkerExit,
          ...(workerEntry ? { workerEntry: resolve(workerEntry) } : {}),
        ...(agentRuntimeModule ? { agentRuntimeModule: resolve(agentRuntimeModule) } : {}),
        }))
  } catch (error) {
    await send({ v: protocol, event: 'failed', error: visible(error) })
    return 2
  }
  await send({
    v: protocol,
    event: 'ready',
    ...(protocol === 2
      ? {
          capabilities: ['operation_receipts', 'undo_mind_v1', 'calendar_v1', 'mind_notes_v1', 'mind_canvases_v1', 'agent_response_chunks_v1'],
          schema: runtime.schemaVersion,
          ownerId: runtime.ownerId,
          nodeVersion: process.versions.node,
          nodeAbi: process.versions.modules,
        }
      : {}),
  })
  const unsubscribe = protocol === 2 ? runtime.onAgentRunChanged((sessionId, runId, interactionChanged) => {
    void send({ v: protocol, event: 'agent_run_changed', sessionId, runId, interactionChanged }).catch(() => {})
  }) : undefined
  const pendingHostRequests = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; dispose(): void }>()
  const unsubscribeHost = protocol === 2 ? runtime.onHostRequest(request => new Promise((resolve, reject) => {
    if (pendingHostRequests.has(request.requestId)) {
      reject(new CoreError('invalid_request', '桌面 Agent 宿主请求标识重复'))
      return
    }
    const abort = () => {
      pendingHostRequests.delete(request.requestId)
      void send({ v: protocol, event: 'host_cancel', requestId: request.requestId }).catch(() => {})
      reject(new CoreError('cancelled', '操作已取消'))
    }
    const frame = { v: protocol, event: 'host_request', requestId: request.requestId,
      method: request.method, params: request.params }
    // 宿主请求超限时在本地拒绝，避免错误响应帧被桌面端误认为协议已失步。
    if (Buffer.byteLength(JSON.stringify(frame)) + 1 > MAX_FRAME) {
      reject(new CoreError('invalid_request', '桌面 Agent 宿主请求超出协议限制'))
      return
    }
    request.signal.addEventListener('abort', abort, { once: true })
    const dispose = () => request.signal.removeEventListener('abort', abort)
    pendingHostRequests.set(request.requestId, { resolve, reject, dispose })
    void send(frame).catch(() => {
      pendingHostRequests.delete(request.requestId)
      dispose()
      reject(new CoreError('storage_error', '桌面 Agent 宿主请求无法发送'))
    })
  })) : undefined
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const pendingResponses = new Set<Promise<void>>()
  let pending = Buffer.alloc(0)
  try {
    for await (const chunk of process.stdin) {
      pending = Buffer.concat([pending, chunk as Buffer])
      let end: number
      while ((end = pending.indexOf(10)) !== -1) {
        if (end + 1 > MAX_FRAME) {
          await send({
            v: protocol,
            id: null,
            error: { code: 'invalid_frame', message: '桌面请求超出协议限制' },
          })
          return 2
        }
        const bytes = pending.subarray(0, end)
        pending = pending.subarray(end + 1)
        try {
          const request: unknown = JSON.parse(decoder.decode(bytes))
          if (protocol === 2 && request && typeof request === 'object' && !Array.isArray(request)
            && 'event' in request && request.event === 'host_response'
            && 'requestId' in request && Number.isSafeInteger(request.requestId) && (request.requestId as number) > 0) {
            const response = request as { requestId: number; result?: unknown; error?: { code?: unknown; message?: unknown } }
            const hostRequest = pendingHostRequests.get(response.requestId)
            if (!hostRequest) continue
            if (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) throw new Error()
            if (Object.hasOwn(response, 'error') && (typeof response.error?.code !== 'string' || typeof response.error?.message !== 'string')) throw new Error()
            pendingHostRequests.delete(response.requestId)
            hostRequest.dispose()
            if (response.error) {
              hostRequest.reject(new CoreError(response.error.code as never, response.error.message as string))
            } else hostRequest.resolve(response.result)
            continue
          }
          const response = desktopFrame(request, runtime, protocol)
            .then(result => sendResponse(request, result))
            .catch(error => send({ v: protocol, id: null, error: visible(error) }))
          pendingResponses.add(response)
          void response.then(() => pendingResponses.delete(response), () => pendingResponses.delete(response))
        } catch (error) {
          await send({ v: protocol, id: null, error: visible(error) })
        }
      }
      if (pending.length >= MAX_FRAME) {
        await send({
          v: protocol,
          id: null,
          error: { code: 'invalid_frame', message: '桌面请求超出协议限制' },
        })
        return 2
      }
    }
    if (pending.length) {
      await send({
        v: protocol,
        id: null,
        error: { code: 'invalid_frame', message: '桌面请求帧不完整' },
      })
      return 2
    }
    await Promise.all(pendingResponses)
    return 0
  } finally {
    unsubscribe?.()
    unsubscribeHost?.()
    for (const request of pendingHostRequests.values()) {
      request.dispose()
      request.reject(new CoreError('closed', 'Core 宿主通信已关闭'))
    }
    pendingHostRequests.clear()
    try { await closeDesktopTerminal() } finally { await runtime.close() }
  }
}
process.exitCode = await main()
