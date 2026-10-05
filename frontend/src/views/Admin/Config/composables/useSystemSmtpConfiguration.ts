import { computed } from 'vue'

interface SmtpDraft {
  host: string
  user: string
  password: string
  from_addr: string
}

export function useSystemSmtpConfiguration(
  smtp: () => SmtpDraft,
  storedPasswordConfigured: () => boolean,
) {
  const smtpConfigured = computed(() => {
    const config = smtp()
    const fromAddress = (config.from_addr || config.user).trim()
    return Boolean(config.host.trim())
      && Boolean(config.user.trim())
      && Boolean(config.password || storedPasswordConfigured())
      && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddress)
  })

  return { smtpConfigured }
}
