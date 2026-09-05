import { ref } from 'vue'
import { scheduledTasksApi } from '@/services/api'

export interface FilesystemAuthorizationApi {
  request: (id: number) => Promise<Record<string, any>>
  confirm: (id: number, confirmCode: string) => Promise<unknown>
  revoke: (id: number) => Promise<unknown>
}

const scheduledTaskAuthorizationApi: FilesystemAuthorizationApi = {
  request: scheduledTasksApi.requestFilesystemAuthorization,
  confirm: scheduledTasksApi.confirmFilesystemAuthorization,
  revoke: scheduledTasksApi.revokeFilesystemAuthorization,
}

/**
 * 当前主体的完整用户沙箱授权前端状态与 API 边界。
 *
 * 业务页面只负责决定授权承载位置和刷新列表；确认码请求、弹窗状态以及
 * 授权/撤销请求集中在这里，避免聊天和定时任务页面各自复制一套权限流程。
 */
export function useFilesystemAuthorization(api: FilesystemAuthorizationApi = scheduledTaskAuthorizationApi) {
  const open = ref(false)
  const busy = ref(false)
  const subjectId = ref<number | null>(null)
  const subjectName = ref('')
  const confirmCode = ref('')

  function close() {
    open.value = false
    subjectId.value = null
    subjectName.value = ''
    confirmCode.value = ''
  }

  async function request(subject: { id: number; name?: string }): Promise<boolean> {
    const pending = await api.request(subject.id)
    if (pending.status === 'authorized') return false
    const code = String(pending.confirm_code || '')
    if (!code) throw new Error('确认请求无效')
    subjectId.value = subject.id
    subjectName.value = subject.name || ''
    confirmCode.value = code
    open.value = true
    return true
  }

  async function confirm() {
    if (subjectId.value == null || !confirmCode.value) return
    busy.value = true
    try {
      await api.confirm(subjectId.value, confirmCode.value)
    } finally {
      busy.value = false
    }
  }

  async function revoke(id: number) {
    await api.revoke(id)
  }

  return {
    open,
    busy,
    subjectId,
    subjectName,
    confirmCode,
    request,
    confirm,
    revoke,
    close,
  }
}
