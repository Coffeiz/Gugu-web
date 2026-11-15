export function extractPlatformMentionIds(text: string | null | undefined): string[] {
  return [...new Set([...(text ?? '').matchAll(/<@!?([A-Za-z0-9_-]{1,64})>/g)].map((match) => match[1]!))]
}

export function replacePlatformMentionIds(text: string | null, names: ReadonlyMap<string, string>): string | null {
  if (text === null || names.size === 0) return text
  let result = text
  for (const [platformUserId, displayName] of names) {
    if (!platformUserId || !displayName) continue
    const escaped = platformUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`<@!?${escaped}>|@${escaped}`, 'g'), () => `@${displayName}`)
  }
  return result
}
