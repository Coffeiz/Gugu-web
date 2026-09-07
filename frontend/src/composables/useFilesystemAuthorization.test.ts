import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requestFilesystemAuthorization: vi.fn(),
  confirmFilesystemAuthorization: vi.fn(),
  revokeFilesystemAuthorization: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  scheduledTasksApi: {
    requestFilesystemAuthorization: mocks.requestFilesystemAuthorization,
    confirmFilesystemAuthorization: mocks.confirmFilesystemAuthorization,
    revokeFilesystemAuthorization: mocks.revokeFilesystemAuthorization,
  },
}))

import { useFilesystemAuthorization } from './useFilesystemAuthorization'

describe('useFilesystemAuthorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a confirmation dialog without granting access on request', async () => {
    mocks.requestFilesystemAuthorization.mockResolvedValue({ confirm_code: 'code-1' })
    const auth = useFilesystemAuthorization()

    await expect(auth.request({ id: 7, name: '脚本任务' })).resolves.toBe(true)

    expect(mocks.requestFilesystemAuthorization).toHaveBeenCalledWith(7)
    expect(auth.open.value).toBe(true)
    expect(auth.subjectId.value).toBe(7)
    expect(auth.subjectName.value).toBe('脚本任务')
  })

  it('confirms and revokes through the task API boundary', async () => {
    mocks.requestFilesystemAuthorization.mockResolvedValue({ confirm_code: 'code-2' })
    mocks.confirmFilesystemAuthorization.mockResolvedValue({ status: 'authorized' })
    mocks.revokeFilesystemAuthorization.mockResolvedValue({ revoked: true })
    const auth = useFilesystemAuthorization()

    await auth.request({ id: 8, name: '定时脚本' })
    await auth.confirm()
    await auth.revoke(8)

    expect(mocks.confirmFilesystemAuthorization).toHaveBeenCalledWith(8, 'code-2')
    expect(mocks.revokeFilesystemAuthorization).toHaveBeenCalledWith(8)
    expect(auth.busy.value).toBe(false)
  })

  it('does not reopen when the backend says the task is already authorized', async () => {
    mocks.requestFilesystemAuthorization.mockResolvedValue({ status: 'authorized' })
    const auth = useFilesystemAuthorization()

    await expect(auth.request({ id: 9 })).resolves.toBe(false)
    expect(auth.open.value).toBe(false)
  })
})
