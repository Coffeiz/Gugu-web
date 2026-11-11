import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { CoreError, frameSchema } from '../contracts/index.js'
import { LocalRuntime } from './local.js'
import { DESKTOP_METHODS, isMutation, validateCommandParams } from './commands.js'

const MAX_FRAME = 65_536
const args = process.argv.slice(2),
  databaseIndex = args.indexOf('--database'),
  protocolIndex = args.indexOf('--protocol')
const database = databaseIndex < 0 ? undefined : args[databaseIndex + 1]
const protocol = protocolIndex < 0 ? 2 : Number(args[protocolIndex + 1])
async function send(value: Record<string, unknown>): Promise<void> {
  let output = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(output) > MAX_FRAME)
    output =
      JSON.stringify({
        v: protocol,
        id: value.id ?? null,
        error: { code: 'result_too_large', message: '结果超出桌面协议限制' },
      }) + '\n'
  if (!process.stdout.write(output)) await once(process.stdout, 'drain')
}
function visible(error: unknown): { code: string; message: string } {
  if (error instanceof CoreError) {
    const messages: Record<string, string> = {
      conflict: '项目或操作已变化，请重新读取',
      not_found: '数据不存在',
      schema_upgrade_required: '数据库需要显式备份升级，请运行 Core migrate',
      cancelled: '操作已取消',
      busy: '本地数据队列已满',
    }
    if (messages[error.code]) return { code: error.code, message: messages[error.code]! }
    if (error.code === 'storage_error' || error.code === 'closed')
      return { code: 'storage_error', message: '本地数据操作失败，请重读数据确认状态' }
  }
  return { code: 'invalid_request', message: '桌面请求无效，请检查字段与能力范围' }
}
async function main(): Promise<number> {
  if (!database || ![1, 2].includes(protocol)) {
    await send({
      v: 2,
      event: 'failed',
      error: { code: 'invalid_request', message: 'Core 启动参数无效' },
    })
    return 2
  }
  let runtime: LocalRuntime
  try {
    runtime = await (existsSync(database)
      ? LocalRuntime.open(database, { allowLegacySchema: protocol === 1 })
      : LocalRuntime.initialize(database))
  } catch (error) {
    await send({ v: protocol, event: 'failed', error: visible(error) })
    return 2
  }
  await send({
    v: protocol,
    event: 'ready',
    ...(protocol === 2
      ? { capabilities: ['operation_receipts'], schema: runtime.schemaVersion }
      : {}),
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
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
        let id: number | null = null
        try {
          const request = frameSchema.parse(JSON.parse(decoder.decode(bytes)))
          if (request.v !== protocol || (protocol === 1 && request.operation_id !== undefined))
            throw new CoreError('invalid_request', '协议版本不兼容')
          id = request.id
          if (
            !(DESKTOP_METHODS as readonly string[]).includes(request.method) ||
            (protocol === 1 && request.method === 'operations.get')
          )
            throw new CoreError('invalid_request', '此能力不可用')
          validateCommandParams(request.method, request.params)
          if (protocol === 2 && isMutation(request.method) && !request.operation_id)
            throw new CoreError('invalid_request', '写入必须提供稳定操作标识')
          if (
            protocol === 1 &&
            request.method.endsWith('.list') &&
            Object.keys(request.params).length
          )
            throw new CoreError('invalid_request', '列表参数无效')
          const result =
            request.method === 'core.info'
              ? {
                  protocol,
                  storage: 'sqlite',
                  accountMode: 'single-user',
                  ...(protocol === 2
                    ? { implementation: 'node', schema: runtime.schemaVersion }
                    : {}),
                }
              : await runtime.call(request.method, request.params, {
                  operationId: request.operation_id,
                })
          await send({ v: protocol, id, result })
        } catch (error) {
          await send({ v: protocol, id, error: visible(error) })
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
    return 0
  } finally {
    await runtime.close()
  }
}
process.exitCode = await main()
