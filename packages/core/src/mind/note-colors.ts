import { PROJECT_COLOR_KEYS } from '../projects/colors.js'

export type NoteColorKey = typeof PROJECT_COLOR_KEYS[number]
export const noteColors = new Set<string>(PROJECT_COLOR_KEYS.map(key => noteColorValue(key)))

export function noteColorValue(key: NoteColorKey): `project:${NoteColorKey}` {
  return `project:${key}`
}
