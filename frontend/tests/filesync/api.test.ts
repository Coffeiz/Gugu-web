import { describe, expect, it } from 'vitest'
import { filesyncAdminApi, type FileSyncReconcileRunStatus } from '@/api/filesync'

describe('filesync admin queue API', () => {
  it('returns the server cancellation state so the queue updates immediately', async () => {
    const run: FileSyncReconcileRunStatus = {
      id: 'run-id',
      bindingId: 7,
      mode: 'snapshot_diff',
      reason: 'manual',
      status: 'cancelled',
      stage: 'finished',
      dryRun: false,
      progressCurrent: 3,
      progressTotal: null,
      resultCounts: { scanned: 3 },
      errorCode: 'cancelled',
    }
    let requestedUrl = ''
    let requestedMethod = ''
    const fetcher = async (url: string, options?: RequestInit) => {
      requestedUrl = url
      requestedMethod = options?.method || 'GET'
      return {
        ok: true,
        json: async () => run,
      } as Response
    }

    const result = await filesyncAdminApi.cancel(fetcher, run.id)

    expect(requestedUrl).toBe(`/api/v1/admin/filesync/runs/${run.id}/cancel`)
    expect(requestedMethod).toBe('POST')
    expect(result).toMatchObject({ status: 'cancelled', stage: 'finished', errorCode: 'cancelled' })
  })
})
