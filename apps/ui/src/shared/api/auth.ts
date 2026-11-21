import { post, request } from '@/api/client'
import { getAuthDeviceId } from '@/utils/authDevice'

export const authApi = {
  sendRegistrationCode: (email: string) => post<{ ok: boolean }>(
    '/auth/registration-code', { email }, { headers: { 'X-Device-ID': getAuthDeviceId() } },
  ),
  updateProfile: (data: any) => request('PATCH', '/auth/profile', data),
  requestEmailChange: (data: { newEmail: string; currentPassword: string }) => request('POST', '/auth/email-change/request', data),
  resendEmailChange: () => request('POST', '/auth/email-change/resend'),
  cancelEmailChange: () => request('POST', '/auth/email-change/cancel'),
  verifyEmailChange: (token: string) => request('POST', '/auth/email-change/verify', { token }),
  getQuota: () => request<{
    used_6h: number
    limit_6h: number | null
    reset_6h_at: string | null
    used_weekly: number
    limit_weekly: number | null
    usage_kind: 'platform' | 'byok'
    is_byok: boolean
    byok_tokens_today: number
    byok_tokens_month: number
    byok_cache_rate: number
  }>('GET', '/auth/quota'),
  getUsageTrends: (days = 30) => request<{
    labels: string[]
    tokens_in: number[]
    cache_read: number[]
    cache_write: number[]
    tokens_out: number[]
    total: number
    daily_avg: number
    today: number
    cache_rate: number
  }>('GET', `/auth/usage/trends?days=${days}`),
  deleteAccount: (password: string) => request('DELETE', '/auth/me', { password }),
  uploadAvatar: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request('POST', '/auth/avatar', form, true)
  },
}
