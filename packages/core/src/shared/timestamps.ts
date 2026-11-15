import { CoreError } from '../contracts/index.js'

// 数据库时间保留微秒。Date 仅用于偏移换算，不经由 Date 存储原小数部分。
export function utc(value: unknown): string {
  if (typeof value !== 'string') throw new CoreError('storage_error', '数据时间格式无效')
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value,
    )
  if (!match) throw new CoreError('storage_error', '数据时间格式无效')
  const fraction = (match[3] ?? '').padEnd(6, '0')
  const wall = new Date(`${match[1]}T${match[2]}Z`)
  if (
    match[1]!.startsWith('0000') ||
    Number.isNaN(wall.getTime()) ||
    wall.toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`
  )
    throw new CoreError('storage_error', '数据时间格式无效')
  let zone = match[4] ?? 'Z'
  if (/^[+-]\d{2}$/.test(zone)) zone += ':00'
  const parsed = new Date(`${match[1]}T${match[2]}${zone}`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() < 1 ||
    parsed.getUTCFullYear() > 9999
  )
    throw new CoreError('storage_error', '数据时间格式无效')
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')}${fraction === '000000' ? '' : `.${fraction}`}+00:00`
}
