import { describe, expect, it } from 'vitest'
import { mapProjectResponse } from '@/types/project'
import type { components } from '@/types/api'

type ProjectResponse = components['schemas']['ProjectResponse']

function projectResponse(overrides: Partial<ProjectResponse> = {}): ProjectResponse {
  return {
    id: 1,
    name: '项目',
    client: null,
    status: 'active',
    startDate: '2026-07-14',
    deadline: null,
    color: '#778899',
    progress: 50,
    stages: [{ key: 's0', label: '计划', todos: [{ id: 't0', text: '整理需求', done: false }] }],
    currentStage: 's0',
    archived: false,
    priority: null,
    version: 1,
    doneAt: null,
    updatedAt: null,
    createdAt: '2026-07-14',
    fileCount: 0,
    ...overrides,
  }
}

describe('mapProjectResponse', () => {
  it('将合法 API 响应收紧为项目领域模型', () => {
    const project = mapProjectResponse(projectResponse())
    expect(project.status).toBe('active')
    expect(project.stages[0].todos[0]).toEqual({ id: 't0', text: '整理需求', done: false })
  })

  it('拒绝非法状态和不完整的阶段数据', () => {
    expect(() => mapProjectResponse(projectResponse({ status: 'paused' }))).toThrow('项目数据格式异常')
    expect(() => mapProjectResponse(projectResponse({ stages: [{ key: 's0' }] }))).toThrow('项目阶段数据格式异常')
  })
})
