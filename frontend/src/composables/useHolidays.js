// 中国法定节假日数据，来源：timor.tech/api/holiday
// holiday: true  → 法定假日/调休休息
// holiday: false → 调休补班（周末上班）
// 按年缓存到 localStorage，30 天后重新拉取

const memCache = {}

async function fetchYear(year) {
  if (memCache[year]) return memCache[year]

  const key = `holidays_${year}`
  const raw = localStorage.getItem(key)
  if (raw) {
    try {
      const { data, fetchedAt } = JSON.parse(raw)
      const age = Date.now() - fetchedAt
      if (age < 30 * 24 * 3600 * 1000) {
        memCache[year] = data
        return data
      }
    } catch {}
  }

  try {
    const res = await fetch(`https://timor.tech/api/holiday/year/${year}/`)
    const json = await res.json()
    if (json.code === 0) {
      memCache[year] = json.holiday
      localStorage.setItem(key, JSON.stringify({ data: json.holiday, fetchedAt: Date.now() }))
      return json.holiday
    }
  } catch {}

  return {}
}

/**
 * 返回 'holiday'（休）| 'workday'（班）| null（普通日）
 * isoDate: "2026-06-21"
 */
function getHolidayType(data, isoDate) {
  if (!data || !isoDate) return null
  const mmdd = isoDate.slice(5)
  const entry = data[mmdd]
  if (!entry) return null
  return entry.holiday ? 'holiday' : 'workday'
}

export function useHolidays() {
  return { fetchYear, getHolidayType }
}
