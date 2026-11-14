import { browserTz } from './dateAttribution'

export interface TimezoneOption {
  value: string
  label: string
}

const fallbackTimezones = [
  'UTC', 'Pacific/Honolulu', 'America/Los_Angeles', 'America/Denver',
  'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London',
  'Europe/Paris', 'Africa/Cairo', 'Asia/Dubai', 'Asia/Kolkata',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
]

function supportedTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  return intl.supportedValuesOf?.('timeZone') ?? fallbackTimezones
}

function offsetLabel(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

export function timezoneOptions(): TimezoneOption[] {
  const values = Array.from(new Set(['UTC', ...supportedTimezones()]))
  return values
    .map(value => ({ value, label: `${offsetLabel(value)} · ${value.replaceAll('_', ' ')}` }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'))
}

export function detectedTimezone(): string {
  return browserTz()
}
