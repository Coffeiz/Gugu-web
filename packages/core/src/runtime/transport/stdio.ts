import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { LocalRuntime } from '../local.js'
import {
  MAX_FRAME,
  boundedFrame,
  desktopFrame,
  visibleError as visible,
} from '../commands.js'

const args = process.argv.slice(2),
  databaseIndex = args.indexOf('--database'),
  protocolIndex = args.indexOf('--protocol')
const database = databaseIndex < 0 ? undefined : args[databaseIndex + 1]
const protocol = protocolIndex < 0 ? 2 : Number(args[protocolIndex + 1])
async function send(value: Record<string, unknown>): Promise<void> {
  const output = boundedFrame(value) + '\n'
  if (!process.stdout.write(output)) await once(process.stdout, 'drain')
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
      ? LocalRuntime.open(database, {
          allowLegacySchema: protocol === 1,
          exclusive: true,
        })
      : LocalRuntime.initialize(database, { exclusive: true }))
  } catch (error) {
    await send({ v: protocol, event: 'failed', error: visible(error) })
    return 2
  }
  await send({
    v: protocol,
    event: 'ready',
    ...(protocol === 2
      ? {
          capabilities: ['operation_receipts'],
          schema: runtime.schemaVersion,
          nodeVersion: process.versions.node,
          nodeAbi: process.versions.modules,
        }
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
        try {
          await send(
            await desktopFrame(JSON.parse(decoder.decode(bytes)), runtime, protocol),
          )
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
    return 0
  } finally {
    await runtime.close()
  }
}
process.exitCode = await main()
