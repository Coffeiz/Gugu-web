import { getLocale } from '@/i18n'
import { effectiveTimezone } from './userTimezone'

export function formatDate(value: Date | string | number, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat(getLocale(), { ...options, timeZone: options.timeZone ?? effectiveTimezone() }).format(new Date(value))
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}

export function formatPercent(value: number, fractionDigits = 0) {
  return formatNumber(value, { style: 'percent', maximumFractionDigits: fractionDigits })
}

export function formatRelativeTime(value: Date | string | number, now = new Date()) {
  const seconds = Math.round((now.getTime() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return getLocale() === 'en-US' ? 'just now' : getLocale() === 'ja-JP' ? 'たった今' : '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return getLocale() === 'en-US' ? `${minutes}m ago` : getLocale() === 'ja-JP' ? `${minutes}分前` : `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return getLocale() === 'en-US' ? `${hours}h ago` : getLocale() === 'ja-JP' ? `${hours}時間前` : `${hours}小时前`
  const days = Math.floor(hours / 24)
  return getLocale() === 'en-US' ? `${days}d ago` : getLocale() === 'ja-JP' ? `${days}日前` : `${days}天前`
}

export function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  // 文件大小保留产品既有精度：B 原样、KB 四舍五入、MB/GB 保留一位小数。
  // 不使用 Intl 的千位分组，避免改变既有的紧凑展示和上传列表宽度。
  const formatted = index === 0 ? String(bytes) : index === 1 ? String(Math.round(value)) : value.toFixed(1)
  return `${formatted} ${units[index]}`
}
