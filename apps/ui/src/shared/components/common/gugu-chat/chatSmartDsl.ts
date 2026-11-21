import { renderSmartView } from './chatSmartViews'

type Node = Record<string, unknown>
type Frame = { parent: Node | null; nodes: Node[]; slot: string }
const identifier = '[a-zA-Z][a-zA-Z0-9_-]*'
const fieldPrefix = new RegExp(`^(${identifier})\\s*=\\s*`)
const nodePrefix = new RegExp(`^(${identifier})(?:\\s+|$)`)
const slotLine = new RegExp(`^@(${identifier})\\s*\\{$`)
const forbiddenKeys = new Set(['type', 'constructor', 'prototype'])

function valueLength(source: string): number {
  const first = source[0]
  if (first !== '"' && first !== '[' && first !== '{') return /^[^\s]+/.exec(source)?.[0].length ?? 0
  let quoted = false
  let escaped = false
  const stack: string[] = []
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        quoted = false
        if (!stack.length) return index + 1
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[' || char === '{') stack.push(char)
    else if (char === ']' || char === '}') {
      if (stack.pop() !== (char === ']' ? '[' : '{')) throw new Error()
      if (!stack.length) return index + 1
    }
  }
  throw new Error()
}

function fields(source: string): Node {
  const result: Node = Object.create(null)
  let remaining = source.trim()
  while (remaining) {
    const prefix = fieldPrefix.exec(remaining)
    if (!prefix || forbiddenKeys.has(prefix[1])) throw new Error()
    const key = prefix[1]
    remaining = remaining.slice(prefix[0].length)
    const length = valueLength(remaining)
    if (!length || (remaining.length > length && !/^\s/.test(remaining[length]))) throw new Error()
    const value = remaining.slice(0, length)
    const parsed = /^(?:\p{L}[\p{L}\p{N}_-]*|%)$/u.test(value) && !['true', 'false', 'null'].includes(value)
      ? value : JSON.parse(value)
    if (Object.hasOwn(result, key) && !Object.is(result[key], parsed)) throw new Error()
    result[key] = parsed
    remaining = remaining.slice(length).trimStart()
  }
  return result
}

export function compileSmartDsl(source: string) {
  if (source.length > 24_000) throw new Error()
  const state: Node = Object.create(null)
  const root: Node[] = []
  const frames: Frame[] = [{ parent: null, nodes: root, slot: '' }]
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    const frame = frames.at(-1)!
    if (line === '}') {
      if (!frame.parent) throw new Error()
      if (frame.nodes.length && Object.hasOwn(frame.parent, frame.slot)) throw new Error()
      if (frame.nodes.length) frame.parent[frame.slot] = frame.nodes
      frames.pop()
      continue
    }
    if (line.startsWith('state ') && !frame.parent) {
      for (const [key, value] of Object.entries(fields(line.slice(6)))) {
        if (Object.hasOwn(state, key)) throw new Error()
        state[key] = value
      }
      continue
    }
    const slot = slotLine.exec(line)?.[1]
    if (slot) {
      if (!frame.parent || frame.slot !== 'children' || forbiddenKeys.has(slot) || slot === 'children') throw new Error()
      frames.push({ parent: frame.parent, nodes: [], slot })
      continue
    }
    const opens = /(?:^|\s)\{$/.test(line)
    const content = opens ? line.slice(0, -1).trimEnd() : line
    const match = nodePrefix.exec(content)
    if (!match) throw new Error()
    const node = { type: match[1], ...fields(content.slice(match[0].length)) }
    frame.nodes.push(node)
    if (opens) frames.push({ parent: node, nodes: [], slot: 'children' })
    if (frames.length > 16) throw new Error()
  }
  if (frames.length !== 1 || !root.length) throw new Error()
  return { version: 1, state, layout: root.length === 1 ? root[0] : { type: 'stack', children: root } }
}

export function renderSmartDsl(source: string) {
  try {
    return renderSmartView(JSON.stringify(compileSmartDsl(source)))
  } catch {
    return renderSmartView('')
  }
}
