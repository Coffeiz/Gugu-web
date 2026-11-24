function decodePath(value: string): string[] | null {
  try {
    return decodeURIComponent(value)
      .split('/')
      .filter(Boolean)
      .reduce<string[]>((parts, part) => {
        if (part === '.') return parts
        if (part === '..') { parts.pop(); return parts }
        parts.push(part)
        return parts
      }, [])
  } catch {
    return null
  }
}

export function isRelativeFileLink(href: string): boolean {
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//')) return false
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return false
  return Boolean(decodePath(href.split('#', 1)[0].split('?', 1)[0])?.length)
}
