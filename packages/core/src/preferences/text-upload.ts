import type { PreferenceTextKind } from './service.js'

export const MAX_PREFERENCE_TEXT_UPLOAD_BYTES = 40_000

export function acceptsPreferenceTextFilename(kind: PreferenceTextKind, filename: string): boolean {
  const name = filename.trim().toLowerCase()
  return name.endsWith('.md') || (kind === 'reply-style' && name.endsWith('.txt'))
}

export function decodePreferenceTextUpload(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
