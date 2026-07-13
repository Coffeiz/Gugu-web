/**
 * 日期归属（按用户/浏览器时区）——见 docs/backend/时区与时钟迁移方案.md Phase 3。
 *
 * 目标口径:一个绝对时刻属于"哪一本地天",以及是不是今天 / 本周。散在日历、思维时间流、
 * Dashboard 里的原生 Date 判断应收敛到这里（纯函数、可测、时区正确）。
 *
 * 关键坑:后端时间串**两种口径并存**——Phase 2 迁移后多数已是 aware（带 `+00:00`，如
 * `2026-07-11T08:00:00+00:00`），但仍有 naive UTC 串（无时区，如 `2026-07-11T08:00:00`），
 * 后者 `new Date(它)` 会按**本地时间**解析 → 整体错一个时区偏移。统一走 parseUtc 显式当 UTC 解析
 * （带时区标记的原样、naive 的补 `Z`），两种口径都对。
 *
 * 周起始 = 周一（国内习惯）。
 */

/** 当前浏览器时区（IANA，如 Asia/Shanghai）。后端迁移出 User.timezone 后由调用方传入覆盖。 */
export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** 把后端时间串解析成绝对时刻:带时区标记（Z / ±hh:mm）就原样，naive 的当 UTC 补 `Z`。 */
export function parseUtc(iso: string | null | undefined): Date {
  if (!iso) return new Date(NaN)
  const hasTime = iso.includes('T')
  const hasTz = /[Zz]$|[+-]\d\d:?\d\d$/.test(iso)
  return new Date(hasTime && !hasTz ? iso + 'Z' : iso)
}

/** 该绝对时刻在 tz 下属于哪一天,返回 `YYYY-MM-DD`（en-CA 天然 ISO 格式）。 */
export function localDayKey(instant: Date, tz: string = browserTz()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

/** 两个时刻在 tz 下是否同一本地天。 */
export function isSameLocalDay(a: Date, b: Date, tz: string = browserTz()): boolean {
  return localDayKey(a, tz) === localDayKey(b, tz)
}

/** 是否"今天"(按 tz 的本地天,不是 UTC 天)。now 可注入便于测试。 */
export function isToday(instant: Date, tz: string = browserTz(), now: Date = new Date()): boolean {
  return isSameLocalDay(instant, now, tz)
}

/** `YYYY-MM-DD` → 该本地日期所在周「周一」的天序号（用纯 UTC 日期算,不再引 tz）。 */
function mondayIndex(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  const dt = Date.UTC(y, m - 1, d)
  const dow = new Date(dt).getUTCDay()          // 0=周日..6=周六
  const toMonday = (dow + 6) % 7                 // 距本周一的天数（周一=0）
  return Math.floor(dt / 86400000) - toMonday
}

/** 是否"本周"(周一为起点,按 tz 的本地周)。now 可注入便于测试。 */
export function isThisWeek(instant: Date, tz: string = browserTz(), now: Date = new Date()): boolean {
  return mondayIndex(localDayKey(instant, tz)) === mondayIndex(localDayKey(now, tz))
}

/** 后端 ISO datetime → 查看者浏览器本地时间串 `YYYY-MM-DD HH:MM`（seconds 时带 :SS）。
 *  给 admin/列表里展示"服务器/后端时间"用——统一走浏览器本地 tz，别再用后端 fmt_local（那是服务器 tz）
 *  或字符串截取（那是 UTC）。空/无效 → 空串。 */
export function fmtLocalDateTime(iso: string | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (!iso) return ''
  const d = parseUtc(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return opts.seconds ? `${s}:${p(d.getSeconds())}` : s
}
