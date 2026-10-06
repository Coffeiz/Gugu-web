export const LIVE_EVENT_PROTOCOL_VERSION = 'live-event-v1' as const
export type LiveResource = 'projects' | 'calendar' | 'files' | 'mind' | 'scheduled_tasks' | 'sessions' | 'clients' | 'im_channels' | 'terminals' | 'pending_queues'
export type LiveOperation = 'create' | 'update' | 'delete' | 'move' | 'append' | 'refresh'

export interface LiveEventPayload {
  protocol_version: typeof LIVE_EVENT_PROTOCOL_VERSION
  event_id: string
  type: 'resource.changed'
  resource: LiveResource
  operation: LiveOperation
  entity_id?: string | number | null
  entity_ids?: Array<string | number>
  revision: number
  payload?: unknown
  origin?: string | null
  mutation_id?: string | null
  created_at: string
}

export interface TrashPurgeProgressEvent {
  protocol_version: typeof LIVE_EVENT_PROTOCOL_VERSION
  event_id: string
  type: 'task.progress'
  task_type: 'trash_purge'
  task_id: number
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress_current: number
  progress_total: number
  failed_count: number
  created_at: string
}

export function isTrashPurgeProgressEvent(value: unknown): value is TrashPurgeProgressEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return event.protocol_version === LIVE_EVENT_PROTOCOL_VERSION
    && typeof event.event_id === 'string' && event.event_id.length > 0
    && event.type === 'task.progress' && event.task_type === 'trash_purge'
    && Number.isSafeInteger(event.task_id) && Number(event.task_id) > 0
    && ['queued', 'running', 'completed', 'failed'].includes(String(event.status))
    && Number.isSafeInteger(event.progress_current) && Number(event.progress_current) >= 0
    && Number.isSafeInteger(event.progress_total) && Number(event.progress_total) >= 0
    && Number.isSafeInteger(event.failed_count) && Number(event.failed_count) >= 0
    && typeof event.created_at === 'string' && !Number.isNaN(Date.parse(event.created_at))
}

export function isLiveEventPayload(value: unknown): value is LiveEventPayload {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  const resources: LiveResource[] = ['projects', 'calendar', 'files', 'mind', 'scheduled_tasks', 'sessions', 'clients', 'im_channels', 'terminals', 'pending_queues']
  const operations: LiveOperation[] = ['create', 'update', 'delete', 'move', 'append', 'refresh']
  return event.protocol_version === LIVE_EVENT_PROTOCOL_VERSION
    && typeof event.event_id === 'string' && event.event_id.length > 0
    && event.type === 'resource.changed'
    && resources.includes(event.resource as LiveResource)
    && operations.includes(event.operation as LiveOperation)
    && Number.isSafeInteger(event.revision)
    && typeof event.created_at === 'string' && !Number.isNaN(Date.parse(event.created_at))
}
