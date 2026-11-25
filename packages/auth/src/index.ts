export { authenticateSession, login, logout, type AuthAccount, type VerifiedIdentity } from './service.js'
export { PasswordChangeError, preparePasswordChange } from './password.js'
export {
  EMAIL_CHANGE_TTL_SECONDS, PASSWORD_RESET_TTL_SECONDS, PASSWORD_RESET_COOLDOWN_SECONDS,
  isRecoveryToken, normalizeEmailChangeAddress, validateEmailChange, validatePasswordReset,
} from './recovery.js'
