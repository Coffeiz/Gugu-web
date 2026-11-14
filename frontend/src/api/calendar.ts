import type { components } from '@/types/api'
import { del, get, patch, post, type RequestMeta } from '@/api/client'

type Schemas = components['schemas']

export const eventsApi = {
  list: (year: number, month: number) => get<Schemas['EventResponse'][]>(`/events?year=${year}&month=${month}`),
  get: (id: number) => get<Schemas['EventResponse']>(`/events/${id}`),
  create: (data: Schemas['EventCreate'], idempotencyKey?: string) =>
    post<Schemas['EventResponse']>(
      '/events', data, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    ),
  update: (id: number, data: Schemas['EventUpdate'], meta?: RequestMeta) =>
    patch<Schemas['EventResponse']>(`/events/${id}`, data, meta),
  delete: (id: number, version: number, meta?: RequestMeta) =>
    del(`/events/${id}?version=${version}`, meta),
}
