import type { ClientRecord, ClientSummary, Fields } from '../contracts/index.js'
import { invalid, length, object, onlyFields, strip } from '../shared/values.js'

export function clientSummary({ id, name, email, phone, address, notes }: ClientRecord): ClientSummary {
  return { id, name, email, phone, address, notes }
}

export function prepareClientFields(fields: Fields, creating = false): Fields {
  object(fields)
  onlyFields(fields, ['name', 'email', 'phone', 'address', 'notes'])
  if (creating && !('name' in fields)) invalid('联系人名称不能为空')
  const limits: Record<string, number | null> = {
    name: 200,
    email: 300,
    phone: 50,
    address: 500,
    notes: null,
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name' || key === 'notes' || value !== null) {
      if (typeof value !== 'string') invalid('联系人字段必须是文本')
      if (key === 'name' && !strip(value)) invalid('联系人名称不能为空')
      const maximum = limits[key]
      if (maximum != null && length(value) > maximum) invalid('联系人字段超过长度限制')
    }
  }
  return { ...fields }
}
