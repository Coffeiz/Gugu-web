export type ConfirmationTargetId = string | number | bigint

export type ConfirmationContext = Readonly<Record<string, string | number | bigint | boolean | null>>

interface TypedTargetId {
  type: 'int' | 'str'
  value: string | number | bigint
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!)
  const rightPoints = Array.from(right, character => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index] - rightPoints[index]
    if (difference) return difference
  }
  return leftPoints.length - rightPoints.length
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('目标确认数字必须是安全整数')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new TypeError('目标确认内容必须是 JSON 值')
}

function normalizeTargetId(value: unknown): TypedTargetId {
  if (typeof value === 'string') {
    if (!value.trim()) throw new TypeError('目标 ID 仅支持非空字符串或整数')
    return { type: 'str', value }
  }
  if (typeof value === 'bigint') return { type: 'int', value }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { type: 'int', value }
  throw new TypeError('目标 ID 仅支持非空字符串或整数')
}

/**
 * 生成与 Python target_confirmation_identity 一致的确定性身份。
 * 目标顺序不影响结果，但 action、context、资源类别和整数/字符串类型均参与身份。
 */
export function targetConfirmationIdentity(
  action: string,
  targets: Readonly<Record<string, readonly ConfirmationTargetId[]>>,
  context?: ConfirmationContext,
): string {
  if (typeof action !== 'string' || !action.trim() || !targets || typeof targets !== 'object' || Array.isArray(targets))
    throw new TypeError('目标确认必须提供 action 和 targets')

  const entries = Object.entries(targets).sort(([left], [right]) => compareCodePoints(left, right))
  if (!entries.length) throw new TypeError('目标确认必须提供 action 和 targets')

  const normalizedTargets = Object.fromEntries(entries.map(([kind, values]) => {
    if (!kind.trim()) throw new TypeError('目标确认的资源类别不能为空')
    if (!Array.isArray(values) || values.length === 0)
      throw new TypeError('每种目标类型都必须提供非空 ID 列表')

    const encoded = values.map(value => {
      const target = normalizeTargetId(value)
      return { target, identity: canonicalJson(target) }
    })
    if (new Set(encoded.map(item => item.identity)).size !== encoded.length)
      throw new TypeError('目标集合不能包含重复 ID')
    encoded.sort((left, right) => compareCodePoints(left.identity, right.identity))
    return [kind, encoded.map(item => item.target)]
  }))

  return `target:${canonicalJson({ action, context: context ?? {}, targets: normalizedTargets })}`
}
