import type { Fields } from '../contracts/index.js'
import { invalid, length, object, onlyFields, strip } from './values.js'

export function prepareClientFields(fields: Fields, creating = false): Fields {
  object(fields)
  onlyFields(fields, ['name', 'contact', 'email', 'phone', 'notes'])
  if (creating && !('name' in fields)) invalid('联系人名称不能为空')
  const limits: Record<string, number | null> = {
    name: 200,
    contact: 200,
    email: 300,
    phone: 50,
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
