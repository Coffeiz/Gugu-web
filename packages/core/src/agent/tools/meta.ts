import { z } from 'zod'
import { createHash } from 'node:crypto'
import { selectToolSchemas } from './schema-selection.js'
import { stableJson } from '../context/history/canonical-history.js'
import type { PreparedToolDefinition, RunIdentity } from '../models.js'
import type { SkillRegistry } from '../skills/contracts.js'
import { SkillRegistryError } from '../skills/registry.js'
import type { ToolDefinition } from './contracts.js'

const inputSchema = z.object({ id: z.string().regex(/^[SU][1-9][0-9]*$/) }).passthrough()

export interface UseSkillPorts {
  readonly skills: SkillRegistry
  /** 来源及指纹由共享技能服务提供，模型参数不能决定。 */
  origin(identity: RunIdentity, id: string, signal: AbortSignal): Promise<
    { source: 'builtin' } | { source: 'user'; ownerFingerprint: string }
  >
}

function toolSchemaEvent(tool: PreparedToolDefinition) {
  return { type: 'tool-schema', tool_name: tool.name, schema_version: 1,
    schema_digest: createHash('sha256').update(stableJson(tool.schema)).digest('hex'), schema: tool.schema }
}

/** 使用真实技能注册器；usage marker 由 Harness 成功合入上下文后再记录摘要。 */
export function createUseSkillTool(ports: UseSkillPorts): ToolDefinition {
  return {
    definition: { name: 'use_skill', schema: { type: 'function', function: {
      name: 'use_skill', description: '按技能 ID 读取技能正文。', parameters: {
        type: 'object', properties: { id: { type: 'string', pattern: '^[SU][1-9][0-9]*$' } }, required: ['id'],
      },
    } } },
    effect: 'read',
    validate(input) { return inputSchema.safeParse(input) },
    async execute(input, scope) {
      const { id } = input as z.infer<typeof inputSchema>
      let loaded
      try { loaded = await ports.skills.load(id, scope.identity, scope.signal) }
      catch (error) {
        scope.signal.throwIfAborted()
        if (!(error instanceof SkillRegistryError) || error.code !== 'unavailable') throw error
        const available = (await ports.skills.catalog(scope.identity)).filter(item => /^S[1-9][0-9]*$/.test(item.id)).map(item => item.id).join('、')
        return { kind: 'completed', successful: false, mutated: false,
          value: { error: `没有 Skill ID 为「${id}」的技能`, available } }
      }
      const origin = await ports.origin(scope.identity, id, scope.signal)
      if ((id.startsWith('U') && origin.source !== 'user') || (id.startsWith('S') && origin.source !== 'builtin')
        || (origin.source === 'user' && !origin.ownerFingerprint.trim())) throw new Error('技能来源无效')
      // 元数据/上下文查询也可能等待；发布正文前重新校验技能当前可见性。
      const visible = await ports.skills.catalog(scope.identity)
      scope.signal.throwIfAborted()
      const skill = visible.find(item => item.id === id)
      if (!skill) throw new SkillRegistryError('unavailable')
      const definitions = skill.related_tools?.length && scope.discoverRelatedTools ? await scope.discoverRelatedTools() : []
      const latest = definitions.length > 0 ? (await ports.skills.catalog(scope.identity)).find(item => item.id === id) : skill
      if (!latest) throw new SkillRegistryError('unavailable')
      scope.signal.throwIfAborted()
      const related = new Set(latest.related_tools ?? [])
      const schemas = definitions.filter(tool => related.has(tool.name))
      const canonicalEvents = schemas.length > 0 ? [
        { type: 'skill-schema', skill_name: id, tool_names: schemas.map(tool => tool.name) },
        ...schemas.map(toolSchemaEvent),
      ] : undefined
      const previous = scope.loadedSkills?.[id]
      if (previous?.digest === loaded.contentDigest && previous.source === origin.source
        && (origin.source === 'builtin' || previous.ownerFingerprint === origin.ownerFingerprint)) return { kind: 'completed', successful: true, mutated: false, value: {
        skill_id: id, skill_name: loaded.name, already_loaded: true,
        message: `技能「${loaded.name}」的正文已在当前上下文中，无需重复加载。`,
      }, ...(canonicalEvents ? { canonicalEvents } : {}) }
      return { kind: 'completed', successful: true, mutated: false, value: {
        skill_id: id, skill_name: loaded.name, content: loaded.content,
        _capability_usage: { kind: 'skill', id, loaded: true, content_digest: loaded.contentDigest,
          ...(origin.source === 'user' ? { source: 'user', owner_fingerprint: origin.ownerFingerprint } : {}) },
      }, ...(canonicalEvents ? { canonicalEvents } : {}) }
    },
  }
}

/** 当前可信注册器的公开能力；不执行目标，也不把发现结果当执行授权。 */
export function createGetToolSchemaTool(capabilities:(identity:RunIdentity)=>Promise<import('../models.js').PreparedToolDefinition[]>):ToolDefinition{
  const schema=z.object({tools:z.array(z.string().min(1).max(80)).min(1).max(12)}).strict()
  return {
    definition:{name:'get_tool_schema',schema:{type:'function',function:{name:'get_tool_schema',description:'获取当前已授权工具的参数Schema声明；只读，不执行目标工具。支持前缀通配符。',
      parameters:{type:'object',properties:{tools:{type:'array',minItems:1,maxItems:12,items:{type:'string',minLength:1,maxLength:80}}},required:['tools'],additionalProperties:false}}}},
    effect:'read',validate:input=>schema.safeParse(input),
    async execute(input,scope){
      const available=scope.discoverRelatedTools ? await scope.discoverRelatedTools() : await capabilities(scope.identity)
      scope.signal.throwIfAborted()
      const value=selectToolSchemas((input as z.infer<typeof schema>).tools,available)
      const names = 'tool_schemas' in value ? value.tool_schemas : []
      const definitions = new Map(available.map(tool => [tool.name, tool]))
      return {kind:'completed',successful:!('error' in value),mutated:false,value,
        ...(names.length ? { canonicalEvents: [
          { type: 'tool-discovery', tool_names: names },
          ...names.map(name => toolSchemaEvent(definitions.get(name)!)),
        ] } : {}),
      }
    },
  }
}

/** 普通问题进入既有交互协调器；沙盒授权由可信授权流程单独提供。 */
export function createAskUserTool():ToolDefinition {
  const option=z.object({id:z.string().min(1).max(64),label:z.string().min(1).max(120)}).strict()
  const schema=z.object({kind:z.enum(['choice','question','form']),title:z.string().max(120),body:z.string().max(1000),authorization:z.literal('user_sandbox').optional(),options:z.array(option).max(8).optional()}).strict()
  return {definition:{name:'ask_user',schema:{type:'function',function:{name:'ask_user',description:'向用户提出澄清问题，等待回答后继续。权限授权和危险操作使用专门的确认流程。',parameters:z.toJSONSchema(schema) as Record<string,import('../models.js').Json>}}},effect:'read',requiresInteraction:true,strictArrayFields:['options'],validate:input=>schema.safeParse(input),
    async execute(input,scope,call){
      const args=input as z.infer<typeof schema>
      if(args.authorization)return {kind:'completed',successful:false,mutated:false,value:{error:'当前工具尚不支持完整用户沙箱授权'}}
      if(args.kind==='form')return {kind:'completed',successful:false,mutated:false,value:{error:'当前交互后端不支持表单'}}
      const options=args.options??[],ids=options.map(item=>item.id.trim())
      if(ids.some(id=>!id||id==='__custom_reply__') || new Set(ids).size!==ids.length || options.some(item=>!item.label.trim()))return {kind:'completed',successful:false,mutated:false,value:{error:'交互选项无效'}}
      const id=createHash('sha256').update(JSON.stringify([scope.identity.ownerId,scope.identity.sessionId,scope.identity.runId,scope.roundId,call.id])).digest('hex')
      return {kind:'waiting',interaction:{id:`question-${id}`,kind:'question',toolCall:call}}
    }}
}
