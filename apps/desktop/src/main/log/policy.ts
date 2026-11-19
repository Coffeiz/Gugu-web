import type { FileLogPolicy } from '@gugu/log/file'

export const regularLogPolicy = { maxBytes: 5 * 1024 * 1024, backups: 5 } satisfies FileLogPolicy
export const diagnosticLogPolicy = { maxBytes: 2 * 1024 * 1024, backups: 3 } satisfies FileLogPolicy
