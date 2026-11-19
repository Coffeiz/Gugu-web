export interface PublicSiteConfig {
  icpNumber: string
  icpUrl: string
  passwordResetEnabled: boolean
  registrationVerificationEnabled: boolean
}

export interface SiteConfigSettings {
  icpNumber: string
  icpUrl: string
  smtpHost: string
  smtpUser: string
  smtpPassword: string
  smtpFromAddress: string
  smtpEnabled: boolean
  registrationVerificationEnabled: boolean
}

export const DEFAULT_PUBLIC_SITE_CONFIG: PublicSiteConfig = Object.freeze({
  icpNumber: '',
  icpUrl: 'https://beian.miit.gov.cn/',
  passwordResetEnabled: false,
  registrationVerificationEnabled: false,
})

function isPlainEmailAddress(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+$/.test(value)
}

export function createPublicSiteConfig(settings: SiteConfigSettings): PublicSiteConfig {
  const senderField = settings.smtpFromAddress.trim()
  const senderAddress = (senderField.includes('@') ? senderField : settings.smtpUser.trim()).trim()
  const emailAvailable = settings.smtpEnabled
    && settings.smtpHost.trim().length > 0
    && settings.smtpUser.trim().length > 0
    && settings.smtpPassword.length > 0
    && isPlainEmailAddress(senderAddress)

  return {
    icpNumber: settings.icpNumber.trim(),
    icpUrl: settings.icpUrl.trim() || DEFAULT_PUBLIC_SITE_CONFIG.icpUrl,
    passwordResetEnabled: emailAvailable,
    registrationVerificationEnabled: settings.registrationVerificationEnabled && emailAvailable,
  }
}
