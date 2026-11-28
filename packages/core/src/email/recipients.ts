export const validEmail = /^[^@\p{White_Space}\u001c-\u001f]+@[^@\p{White_Space}\u001c-\u001f]+\.[^@\p{White_Space}\u001c-\u001f]+$/u

export type EmailRecipientGroups = Record<'zh-CN' | 'ja-JP' | 'en-US', string[]>
