import {utc} from '../shared/timestamps.js'

const liveResources = new Set(['projects','calendar','files','mind','scheduled_tasks','sessions','clients','im_channels','terminals','pending_queues','skills'])
const liveOperations = new Set(['create','update','delete','move','append','refresh'])

// datetime.fromisoformat 接受紧凑日期、周日期及单个 Unicode 分隔符；不以 Date.parse 扩大输入。
function isTimestamp(value:string):boolean {
 const match=/^(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}-W\d{2}(?:-\d)?|\d{4}W\d{2}\d?)(.*)$/u.exec(value)
 if(!match)return false
 const date=match[1]!,year=Number(date.slice(0,4))
 if(year<1||year>9999)return false
 if(date.includes('W')){
  const weekMatch=/^\d{4}-?W(\d{2})(?:-?(\d))?$/.exec(date)
  if(!weekMatch)return false
  const week=Number(weekMatch[1]),day=Number(weekMatch[2]??1)
  const january4=new Date(0);january4.setUTCFullYear(year,0,4);january4.setUTCHours(0,0,0,0)
  const nextJanuary4=new Date(0);nextJanuary4.setUTCFullYear(year+1,0,4);nextJanuary4.setUTCHours(0,0,0,0)
  const monday=january4.getTime()-((january4.getUTCDay()+6)%7)*86400000
  const nextMonday=nextJanuary4.getTime()-((nextJanuary4.getUTCDay()+6)%7)*86400000
  if(week<1||week>(nextMonday-monday)/604800000||day<1||day>7)return false
  const resolved=new Date(monday+(week-1)*604800000+(day-1)*86400000)
  if(resolved.getUTCFullYear()>9999)return false
 }else{
  const expanded=date.length===8?`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`:date
  try{utc(`${expanded}T00:00:00`)}catch{return false}
 }
 if(!match[2])return true
 const characters=Array.from(match[2]!),time=characters.slice(1).join('')
 const timeMatch=/^(\d{2}(?::\d{2}(?::\d{2})?)?|\d{4}|\d{6})(?:[.,]\d+)?(Z|[+-].*)?$/.exec(time)
 if(!timeMatch)return false
 const parts=(clock:string)=>clock.includes(':')?clock.split(':').map(Number):[Number(clock.slice(0,2)),Number(clock.slice(2,4)||0),Number(clock.slice(4,6)||0)]
 const [hour=0,minute=0,second=0]=parts(timeMatch[1]!)
 if(hour>23||minute>59||second>59)return false
 const zone=timeMatch[2]
 if(!zone||zone==='Z')return true
 const offset=/^[+-](\d{2}(?::\d{2}(?::\d{2})?)?|\d{4}|\d{6})(?:[.,](\d+))?$/.exec(zone)
 if(!offset)return false
 const [zoneHour=0,zoneMinute=0,zoneSecond=0]=parts(offset[1]!)
 return zoneHour*3600+zoneMinute*60+zoneSecond+Number(`0.${offset[2]??0}`)<86400
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isLiveEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'resource.changed'
    && typeof value.resource === 'string' && liveResources.has(value.resource)
    && typeof value.operation === 'string' && liveOperations.has(value.operation)
    && isInteger(value.revision)
    && typeof value.created_at === 'string'
}

function isTrashPurgeProgressEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'task.progress'
    && value.task_type === 'trash_purge'
    && isInteger(value.task_id) && value.task_id > 0
    && typeof value.status === 'string'
    && ['queued', 'running', 'completed', 'failed'].includes(value.status)
    && isInteger(value.progress_current) && value.progress_current >= 0
    && isInteger(value.progress_total) && value.progress_total >= 0
    && isInteger(value.failed_count) && value.failed_count >= 0
    && typeof value.created_at === 'string'
}

function isAgentRunChangedEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'agent.run.changed'
    && isInteger(value.session_id) && value.session_id > 0
    && (value.run_id === undefined || typeof value.run_id === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value.run_id))
    && ['running', 'waiting', 'completed', 'failed'].includes(String(value.status))
    && typeof value.created_at === 'string'
}

function sanitizeAgentRunChangedEvent(value: Record<string, unknown>): Record<string, unknown> {
  const fields = ['protocol_version', 'event_id', 'type', 'session_id', 'run_id', 'status', 'created_at']
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]))
}

function isFilesyncEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || value.protocol_version !== 'live-event-v1'
    || typeof value.event_id !== 'string' || !value.event_id
    || !isInteger(value.binding_id) || value.binding_id <= 0
    || !isInteger(value.revision) || value.revision < 0
    || typeof value.created_at !== 'string'
    || !isTimestamp(value.created_at)) return false
  if (value.type === 'filesync.run.changed')
    return typeof value.run_id === 'string' && value.run_id.length > 0
  return value.type === 'filesync.binding.health.changed'
}

function sanitizeFilesyncEvent(value: Record<string, unknown>): Record<string, unknown> {
  const fields = ['protocol_version', 'event_id', 'type', 'binding_id', 'revision', 'created_at']
  if (value.type === 'filesync.run.changed') fields.push('run_id')
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]))
}

/** 接受与 Python live stream 相同的业务 envelope，并裁剪 filesync/agent 事件字段。 */
export function serializeLiveMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return null
  }

  if (isFilesyncEvent(value)) value = sanitizeFilesyncEvent(value)
  else if (isAgentRunChangedEvent(value)) value = sanitizeAgentRunChangedEvent(value)
  else if (!(isLiveEvent(value) || isTrashPurgeProgressEvent(value)
    || (isRecord(value) && isRecord(value.notification))
    || (isRecord(value) && isRecord(value.present)
      && isInteger(value.present.file_id)))) return null

  return `data: ${JSON.stringify(value)}\n\n`
}
