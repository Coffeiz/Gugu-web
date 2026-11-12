import type { Fields, ProjectRecord, Stage, Todo } from '../contracts/index.js'
import { PROJECT_COLOR_PRESETS } from './colors.js'
import { invalid, length, object, onlyFields, pythonJson, strip } from './values.js'

const writable = [
  'name',
  'summary',
  'client',
  'status',
  'start_date',
  'deadline',
  'color',
  'progress',
  'current_stage',
  'archived',
  'priority',
  'stages',
]
function date(value: unknown, label: string): void {
  if (value === null || value === undefined) return
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    invalid(`${label} 必须是 YYYY-MM-DD 格式`)
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const test = new Date(0)
  test.setUTCFullYear(year, month - 1, day)
  test.setUTCHours(0, 0, 0, 0)
  if (
    year < 1 ||
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  )
    invalid(`${label} 必须是 YYYY-MM-DD 格式`)
}
export function validateStages(value: unknown): asserts value is Stage[] {
  if (!Array.isArray(value)) invalid('项目阶段必须是对象列表')
  const keys = new Set<string>(),
    ids = new Set<string>()
  for (const item of value) {
    object(item)
    if (typeof item.key !== 'string' || !strip(item.key)) invalid('阶段 key 不能为空')
    if (keys.has(item.key)) invalid('阶段 key 不能重复')
    keys.add(item.key)
    if (typeof item.label !== 'string' || !strip(item.label)) invalid('阶段名称不能为空')
    const todos = 'todos' in item ? item.todos : []
    if (!Array.isArray(todos)) invalid('阶段 todos 必须是列表')
    for (const todo of todos) {
      object(todo)
      if (typeof todo.id !== 'string' || !strip(todo.id)) invalid('待办 id 不能为空')
      if (ids.has(todo.id)) invalid('待办 id 不能重复')
      ids.add(todo.id)
      if ('text' in todo && typeof todo.text !== 'string') invalid('待办内容必须是文本')
      if ('done' in todo && typeof todo.done !== 'boolean') invalid('待办完成状态必须是布尔值')
    }
  }
}
function decimal(value: string): number | null {
  if (!/^\p{Decimal_Number}+$/u.test(value)) return null
  let result = 0
  for (const char of value) {
    const point = char.codePointAt(0)!
    let start = point
    while (start > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--
    result = result * 10 + ((point - start) % 10)
  }
  if (!Number.isSafeInteger(result)) invalid('阶段编号超出安全范围')
  return result
}
function incrementCounter(value: number): number {
  if (!Number.isSafeInteger(value + 1)) invalid('阶段或待办编号超出安全范围')
  return value + 1
}
export function nextProjectStageKey(stages: Stage[], prefix = 's'): string {
  let largest = -1
  for (const stage of stages)
    if (stage.key.startsWith(prefix)) {
      const suffix = decimal(stage.key.slice(prefix.length))
      if (suffix !== null) largest = Math.max(largest, suffix)
    }
  return `${prefix}${incrementCounter(largest)}`
}
export function nextProjectTodoNumber(stages: Stage[]): number {
  let largest = 0
  for (const stage of stages)
    for (const todo of stage.todos ?? [])
      if (todo.id.startsWith('t')) {
        const suffix = decimal(todo.id.slice(1))
        if (suffix !== null) largest = Math.max(largest, suffix)
      }
  return largest
}
export function findProjectStage(stages: Stage[], target: string): Stage | undefined {
  const name = strip(target)
  return stages.find((stage) => stage.key === name || stage.label === name)
}
export function normalizeProjectStages(raw: unknown): Stage[] {
  if (!Array.isArray(raw) || raw.length === 0) invalid('项目阶段必须是非空列表')
  let number = 0
  const result = raw.map((item: unknown, index): Stage => {
    const source = typeof item === 'string' ? { label: item } : item
    object(source)
    onlyFields(source, ['label', 'todos'])
    if (typeof source.label !== 'string' || !strip(source.label))
      invalid(`第 ${index + 1} 个阶段必须提供非空 label`)
    const todos = 'todos' in source ? source.todos : []
    if (!Array.isArray(todos)) invalid('阶段 todos 必须是列表')
    return {
      key: `s${index}`,
      label: strip(source.label),
      todos: todos.map((text: unknown): Todo => {
        if (typeof text !== 'string' || !strip(text)) invalid('待办必须是非空文本')
        number = incrementCounter(number)
        return { id: `t${number}`, text: strip(text), done: false }
      }),
    }
  })
  validateStages(result)
  return result
}
export function replaceProjectStages(
  old: Stage[],
  current: string | null,
  raw: unknown,
): [Stage[], string] {
  if (!Array.isArray(raw) || raw.length === 0) invalid('需提供非空 stages 列表')
  const used = new Set<string>()
  let number = nextProjectTodoNumber(old)
  const result: Stage[] = []
  for (const entry of raw) {
    const item = typeof entry === 'string' ? { label: entry } : entry
    object(item)
    onlyFields(item, ['key', 'label', 'todos'])
    if (typeof item.label !== 'string' || !strip(item.label)) invalid('阶段必须提供非空 label')
    const label = strip(item.label)
    let previous: Stage | undefined
    if (item.key !== undefined && item.key !== null) {
      if (typeof item.key !== 'string' || !strip(item.key)) invalid('阶段 key 必须是非空文本')
      previous = old.find((stage) => stage.key === item.key)
      if (!previous) invalid(`阶段 key 不存在: ${item.key}`)
    } else {
      const matches = old.filter((stage) => stage.label === label)
      if (matches.length > 1) invalid(`阶段名称「${label}」重名，请在 stages 项中提供 key`)
      previous = matches[0]
    }
    const key = previous?.key ?? nextProjectStageKey([...old, ...result])
    if (used.has(key)) invalid('阶段 key 不能重复')
    used.add(key)
    let todos: Todo[] = previous?.todos?.map((todo) => ({ ...todo })) ?? []
    if ('todos' in item) {
      if (!Array.isArray(item.todos)) invalid('阶段 todos 必须是列表')
      todos = item.todos.map((text: unknown) => {
        if (typeof text !== 'string' || !strip(text)) invalid('待办必须是非空文本')
        number = incrementCounter(number)
        return { id: `t${number}`, text: strip(text), done: false }
      })
    }
    result.push({ key, label, todos })
  }
  validateStages(result)
  return [result, result.some((stage) => stage.key === current) ? current! : result[0]!.key]
}
export function prepareProjectUpdate(fields: Fields, existing?: ProjectRecord): Fields {
  object(fields)
  onlyFields(fields, writable)
  const values = { ...fields }
  if ('name' in values && (typeof values.name !== 'string' || !strip(values.name)))
    invalid('名称不能为空')
  if (typeof values.name === 'string' && /[\\/:*?"<>|]/.test(values.name))
    invalid('名称不能包含以下字符：\\ / : * ? " < > |')
  if (typeof values.name === 'string' && length(values.name) > 200)
    invalid('名称不能超过 200 个字符')
  if ('summary' in values) {
    if (values.summary !== null && typeof values.summary !== 'string')
      invalid('项目摘要必须是文本或空值')
    values.summary = values.summary === null ? null : strip(values.summary as string) || null
    if (typeof values.summary === 'string' && length(values.summary) > 200)
      invalid('项目摘要不能超过 200 个字符')
  }
  if ('status' in values && !['pending', 'active', 'done'].includes(values.status as string))
    invalid('项目状态必须是 pending、active 或 done')
  if (
    'priority' in values &&
    values.priority !== null &&
    !['high', 'medium', 'low'].includes(values.priority as string)
  )
    invalid('优先级必须是 high、medium、low 或空')
  if (
    'color' in values &&
    !PROJECT_COLOR_PRESETS.includes(values.color as (typeof PROJECT_COLOR_PRESETS)[number])
  )
    invalid('颜色必须是预设色板中的值')
  if (
    'progress' in values &&
    (typeof values.progress !== 'number' ||
      !Number.isInteger(values.progress) ||
      values.progress < 0 ||
      values.progress > 100)
  )
    invalid('项目进度必须是 0 到 100 的整数')
  if ('archived' in values && typeof values.archived !== 'boolean') invalid('归档状态必须是布尔值')
  if ('client' in values && values.client !== null && typeof values.client !== 'string')
    invalid('联系人必须是文本或空值')
  if (typeof values.client === 'string' && length(values.client) > 200)
    invalid('联系人不能超过 200 个字符')
  if (typeof values.current_stage === 'string' && length(values.current_stage) > 100)
    invalid('当前阶段标识不能超过 100 个字符')
  date(values.start_date, '开始日期')
  date(values.deadline, '截止日期')
  const start = 'start_date' in values ? values.start_date : existing?.start_date
  const end = 'deadline' in values ? values.deadline : existing?.deadline
  if (start && end && String(start) > String(end)) invalid('开始日期不能晚于截止日期')
  if ('stages' in values) {
    validateStages(values.stages)
    const current = 'current_stage' in values ? values.current_stage : existing?.current_stage
    if (current != null && !values.stages.some((stage) => stage.key === current))
      invalid('当前阶段必须属于阶段列表')
    values.stages_json = pythonJson(values.stages)
    delete values.stages
  } else if ('current_stage' in values && values.current_stage !== null) {
    const stages: Stage[] = existing ? JSON.parse(existing.stages_json) : []
    if (!stages.some((stage) => stage.key === values.current_stage))
      invalid('当前阶段必须属于阶段列表')
  }
  return values
}
export function prepareProjectCreate(fields: Fields): Fields {
  const values = prepareProjectUpdate(fields)
  if (!('name' in values)) invalid('名称不能为空')
  return values
}
