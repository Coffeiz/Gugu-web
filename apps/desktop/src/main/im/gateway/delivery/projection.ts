import type { ImChartRenderer } from '@gugu/gateway'
import { randomUUID } from 'node:crypto'
import type { safeStorage } from 'electron'
import type { QqProjectionOptions } from '@gugu/gateway/qq'
import type { IpcHost } from '../../../ipc/types.js'

export type DesktopImProjectionTarget = { platform: 'qq' | 'telegram' | 'feishu'; connectionId: string; eventKey: string; runId: string }
type Encryption = Pick<typeof safeStorage, 'encryptStringAsync' | 'decryptStringAsync'>

export function createDesktopImProjectionReceipts(host: IpcHost, encryption: Encryption, target: DesktopImProjectionTarget) {
  const request = <T>(action: string, params: Record<string, unknown> = {}) =>
    host.request<T>('im.inbox.projection', { ...target, action, ...params })
  const scope = JSON.stringify([target.platform, target.connectionId, target.eventKey, target.runId])

  async function save(action: 'checkpoint' | 'accepted', version: number, state: unknown, key?: string) {
    const sealed = (await encryption.encryptStringAsync(JSON.stringify({ scope, version: version + 1, state }))).toString('base64')
    if (sealed.length > 1_450_000) throw new Error('本机 IM 投递检查点超限')
    const uploadId = randomUUID()
    const chunkSize = 24_000
    const total = Math.ceil(sealed.length / chunkSize)
    for (let part = 0; part < total; part++)
      await request('stage', { uploadId, part, total, chunk: sealed.slice(part * chunkSize, (part + 1) * chunkSize) })
    return request<number>(action, { version, uploadId, ...(key ? { key } : {}) })
  }

  return {
    begin: (_identity, key, fingerprint) => request<'new' | 'accepted' | 'pending' | 'unknown'>('begin', { key, fingerprint }),
    async settle(_identity, key, outcome) { await request('settle', { key, outcome }) },
    projection: {
      platform: target.platform,
      async read() {
        const { version, state, plain } = await request<{ version: number; state: string | null; plain?: true }>('read')
        if (state === null) return { version, state, plain }
        const { result } = await encryption.decryptStringAsync(Buffer.from(state, 'base64'))
        const decoded: { version: number; scope: string; state: unknown } = JSON.parse(result)
        if (decoded.scope !== scope || decoded.version !== version)
          throw new Error('本机 IM 投递检查点不匹配')
        return { version, state: decoded.state, plain }
      },
      checkpoint: (version, state) => save('checkpoint', version, state),
      accepted: (key, version, state) => save('accepted', version, state, key),
    },
  } satisfies QqProjectionOptions['receipts']
}

export function createDesktopImChartRenderer(host: IpcHost, authorize: () => Promise<boolean>): ImChartRenderer {
  return async (request, signal) => {
    const [chart] = request.charts
    if (!chart || signal?.aborted || !await authorize()) return []
    const encoded = await host.request<string | null>('im.chart.render', chart)
    return [encoded && !signal?.aborted ? Buffer.from(encoded, 'base64') : null]
  }
}
