import { computed, inject, onMounted, provide, ref, shallowRef, watch, type InjectionKey } from 'vue'
import type { MailAccountSummary } from '@gugu/email/contracts'
import { useMailAccess } from '@/api/mail'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { useInboxWatch } from './useInboxWatch'

const inboxStatusKey: InjectionKey<ReturnType<typeof provideMailInboxStatus>> = Symbol('mailInboxStatus')

export function provideMailInboxStatus() {
  const { request } = useMailAccess()
  const accounts = ref<MailAccountSummary[]>([])
  const unreadCounts = ref<Record<string, number>>({})
  const lastChange = shallowRef<{ id: string }>()
  const accountIds = computed(() => accounts.value.map(account => account.id))
  const unreadTotal = computed(() => accountIds.value.reduce((total, id) => total + (unreadCounts.value[id] ?? 0), 0))

  let sequence = 0
  async function refreshAccounts() {
    const version = ++sequence
    const result = await request<MailAccountSummary[]>({ action: 'accounts' })
    if (version === sequence) {
      accounts.value = result
      const connected = new Set(result.map(account => account.id))
      unreadCounts.value = Object.fromEntries(Object.entries(unreadCounts.value).filter(([id]) => connected.has(id)))
    }
    return result
  }

  watch(accountBoundaryEpoch, () => {
    sequence++
    accounts.value = []
    unreadCounts.value = {}
    lastChange.value = undefined
  }, { flush: 'sync' })

  const refreshInboxCount = useInboxWatch(request, accountIds,
    id => { lastChange.value = { id } },
    (id, count) => { unreadCounts.value[id] = count })
  onMounted(() => {
    if (!sequence) void refreshAccounts().catch(() => { /* 邮箱页面可重试并展示连接错误。 */ })
  })

  const status = { accounts, unreadCounts, unreadTotal, lastChange, refreshAccounts, refreshInboxCount }
  provide(inboxStatusKey, status)
  return status
}

export function useMailInboxStatus() {
  const status = inject(inboxStatusKey)
  if (!status) throw new Error('未装配邮箱收件箱状态')
  return status
}
