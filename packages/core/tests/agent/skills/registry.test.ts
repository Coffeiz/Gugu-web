import { describe, expect, it, vi } from 'vitest'
import { createSkillRegistry, SkillRegistryError } from '../../../src/agent/skills/index.js'
import type { SkillDefinition } from '../../../src/agent/skills/index.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const signal = () => new AbortController().signal
function skill(id = 'write'): SkillDefinition {
  return { id, name: '写作', description: '组织文章', load: async () => ({ content: '写作正文', contentDigest: 'host-digest' }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('Skill注册器发现与正文加载', () => {
  it('默认启用注册技能，按可信身份加载并保留Host摘要', async () => {
    const loader = vi.fn(skill().load)
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: async () => true })
    expect(await registry.catalog(identity)).toEqual([{ id: 'write', name: '写作', description: '组织文章' }])
    const abort = signal()
    expect(await registry.load('write', identity, abort)).toEqual({ id: 'write', name: '写作', content: '写作正文', contentDigest: 'host-digest' })
    expect(loader).toHaveBeenCalledWith(identity, abort)
  })
  it('register与configure保存快照，调用方修改不会改变元数据或配置', async () => {
    const definition = { ...skill() }
    const configuration = { skills: { write: false } }
    const registry = createSkillRegistry({ skills: [definition], authorize: async () => true, configuration })
    Object.assign(definition, { name: '污染', load: async () => ({ content: '污染', contentDigest: 'wrong' }) })
    configuration.skills.write = true
    expect(await registry.catalog(identity)).toEqual([])
    registry.configure({})
    const catalog = await registry.catalog(identity)
    catalog[0] = { id: '污染', name: '污染', description: '' }
    expect(await registry.load('write', identity, signal())).toMatchObject({ name: '写作', content: '写作正文' })
    expect((await registry.catalog(identity))[0]?.id).toBe('write')
  })
  it('配置替换恢复默认启用并允许动态注册', async () => {
    const registry = createSkillRegistry({ authorize: async () => true })
    registry.register(skill())
    registry.configure({ skills: { write: false } })
    await expect(registry.load('write', identity, signal())).rejects.toMatchObject({ code: 'unavailable' })
    registry.configure({})
    expect(await registry.catalog(identity)).toHaveLength(1)
  })
  it('非法配置原子拒绝而不覆盖原配置', async () => {
    const registry = createSkillRegistry({ skills: [skill()], authorize: async () => true, configuration: { skills: { write: false } } })
    expect(() => registry.configure({ skills: { unknown: true } })).toThrow('技能配置无效')
    expect(await registry.catalog(identity)).toEqual([])
  })
  it.each([{ id: '' }, { id: '  ' }, { id: ' write' }, { load: null }, { name: '' }])('启动拒绝非法定义 %j', patch => {
    expect(() => createSkillRegistry({ skills: [{ ...skill(), ...patch } as SkillDefinition], authorize: async () => true })).toThrow()
  })
  it('重复技能及未知配置启动拒绝', () => {
    expect(() => createSkillRegistry({ skills: [skill(), skill()], authorize: async () => true })).toThrow()
    expect(() => createSkillRegistry({ skills: [skill()], authorize: async () => true, configuration: { skills: { unknown: false } } })).toThrow()
  })
  it('发现后权限变化，加载重新判权且不调用loader', async () => {
    let authorized = true
    const loader = vi.fn(skill().load)
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: async () => authorized })
    expect(await registry.catalog(identity)).toHaveLength(1)
    authorized = false
    await expect(registry.load('write', identity, signal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(loader).not.toHaveBeenCalled()
  })
  it('异步判权期间撤销配置，发现与加载都必须拒绝', async () => {
    for (const action of ['catalog', 'load']) {
      const authorization = deferred<boolean>()
      const loader = vi.fn(skill().load)
      const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: () => authorization.promise })
      const pending = action === 'catalog' ? registry.catalog(identity) : registry.load('write', identity, signal())
      registry.configure({ skills: { write: false } })
      authorization.resolve(true)
      if (action === 'catalog') expect(await pending).toEqual([])
      else await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
      expect(loader).not.toHaveBeenCalled()
    }
  })
  it('加载期间撤销配置，不交付正文', async () => {
    const content = deferred<{ content: string; contentDigest: string }>()
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: () => content.promise }], authorize: async () => true })
    const pending = registry.load('write', identity, signal())
    await Promise.resolve(); await Promise.resolve()
    registry.configure({ skills: { write: false } })
    content.resolve({ content: '私密正文', contentDigest: 'digest' })
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  })
  it('授权及loader异常不回显原始异常或敏感内容', async () => {
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: async () => { throw new Error('secret-token') } }], authorize: async () => true })
    await expect(registry.load('write', identity, signal())).rejects.toEqual(new SkillRegistryError('load_failed'))
    const denied = createSkillRegistry({ skills: [skill()], authorize: async () => { throw new Error('secret-token') } })
    expect(await denied.catalog(identity)).toEqual([])
    await expect(denied.load('write', identity, signal())).rejects.toEqual(new SkillRegistryError('unavailable'))
  })
  it('非法loader结果拒绝，已取消请求不加载正文', async () => {
    const loader = vi.fn(async () => ({ content: '正文', contentDigest: '' }))
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: async () => true })
    await expect(registry.load('write', identity, signal())).rejects.toMatchObject({ code: 'load_failed' })
    loader.mockClear()
    const controller = new AbortController(); controller.abort(new Error('已取消'))
    await expect(registry.load('write', identity, controller.signal)).rejects.toThrow('已取消')
    expect(loader).not.toHaveBeenCalled()
  })
  it('判权等待中取消，不启动loader并传播取消', async () => {
    const authorization = deferred<boolean>()
    const loader = vi.fn(skill().load)
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: () => authorization.promise })
    const controller = new AbortController()
    const pending = registry.load('write', identity, controller.signal)
    controller.abort(new Error('判权期间取消'))
    authorization.resolve(true)
    await expect(pending).rejects.toThrow('判权期间取消')
    expect(loader).not.toHaveBeenCalled()
  })
  it('后续技能判权期间撤销先前条目，目录不残留撤权条目', async () => {
    const registry = createSkillRegistry({ skills: [skill(), skill('draw')], authorize: async (_identity, id) => {
      if (id === 'draw') registry.configure({ skills: { write: false } })
      return true
    } })
    expect(await registry.catalog(identity)).toEqual([{ id: 'draw', name: '写作', description: '组织文章' }])
  })
  it('loader取消传播原取消原因而不转换成普通失败', async () => {
    const controller = new AbortController()
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: async () => { controller.abort(new Error('已取消')); throw new Error('原始异常') } }], authorize: async () => true })
    await expect(registry.load('write', identity, controller.signal)).rejects.toThrow('已取消')
  })
})

describe('技能正文发布前再次核验动态权限', () => {
  it('loader已开始后动态撤权且未configure，也不得返回已读取正文', async () => {
    const entered = deferred<void>(), body = deferred<{ content: string; contentDigest: string }>()
    let authorized = true
    const loader = vi.fn(async () => { entered.resolve(); return body.promise })
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: loader }], authorize: async () => authorized })
    const pending = registry.load('write', identity, signal())
    await entered.promise
    authorized = false
    const rejected = expect(pending).rejects.toEqual(new SkillRegistryError('unavailable'))
    body.resolve({ content: '合成受限技能正文', contentDigest: 'private-digest' })
    await rejected
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('post-load授权服务异常安全拒绝，不透出正文、摘要或原始异常', async () => {
    const entered = deferred<void>(), body = deferred<{ content: string; contentDigest: string }>()
    let loaded = false
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: async () => {
      entered.resolve(); const content = await body.promise; loaded = true; return content
    } }], authorize: async () => {
      if (loaded) throw new Error('synthetic-credential-with-private-content')
      return true
    } })
    const pending = registry.load('write', identity, signal())
    await entered.promise
    const rejected = expect(pending).rejects.toEqual(new SkillRegistryError('unavailable'))
    body.resolve({ content: '合成私有正文', contentDigest: 'synthetic-private-digest' })
    await rejected
  })
  it('post-load授权等待期间取消，须等待授权返回后传播取消而不交正文', async () => {
    const entered = deferred<void>(), body = deferred<{ content: string; contentDigest: string }>(), authEntered = deferred<void>(), authorization = deferred<boolean>()
    let loaded = false, settled = false
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: async () => {
      entered.resolve(); const content = await body.promise; loaded = true; return content
    } }], authorize: async () => {
      if (!loaded) return true
      authEntered.resolve(); return authorization.promise
    } })
    const controller = new AbortController(), reason = new Error('正文再授权期间取消')
    const pending = registry.load('write', identity, controller.signal).finally(() => { settled = true })
    await entered.promise
    body.resolve({ content: '合成不得发布正文', contentDigest: 'digest' })
    await authEntered.promise
    try {
      controller.abort(reason)
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally { authorization.resolve(true) }
    await expect(pending).rejects.toBe(reason)
    expect(settled).toBe(true)
  })
  it('loader后权限仍有效时正文和Host摘要原样返回，重新判权使用可信身份', async () => {
    const entered = deferred<void>(), body = deferred<{ content: string; contentDigest: string }>()
    let loaded = false
    const authorize = vi.fn(async (received: typeof identity, id: string) => {
      expect(received).toEqual(identity)
      expect(Object.isFrozen(received)).toBe(true)
      expect(id).toBe('write')
      return true
    })
    const registry = createSkillRegistry({ skills: [{ ...skill(), load: async () => {
      entered.resolve(); const result = await body.promise; loaded = true; return result
    } }], authorize })
    const pending = registry.load('write', identity, signal())
    await entered.promise
    body.resolve({ content: '正常正文\n保留格式', contentDigest: 'host-original-digest' })
    expect(await pending).toEqual({ id: 'write', name: '写作', content: '正常正文\n保留格式', contentDigest: 'host-original-digest' })
    expect(loaded).toBe(true)
  })
})
