#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { needsFields, objects, renderHelp } from './help.js'
import { createDesktopClient } from './client/desktop.js'

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' }, desktop: { type: 'boolean' }, offset: { type: 'string' }, json: { type: 'boolean' }, fields: { type: 'string' },
      archived: { type: 'boolean' }, deleted: { type: 'boolean' }, yes: { type: 'boolean' },
    },
  })
  const [object, action, id] = positionals
  if (values.help || positionals.length === 0) {
    if (positionals.length > 2) throw new Error('用 gugu <对象> <命令> --help 查看帮助')
    console.log(renderHelp(object, action))
    return
  }
  if (!object || !action || !Object.hasOwn(objects, object) || !Object.hasOwn(objects[object].actions, action))
    throw new Error('未知命令，请查看 gugu --help')
  const needsId = action !== 'list' && action !== 'create'
  if (positionals.length !== (needsId ? 3 : 2) ||
      (needsId && (!id || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))))
    throw new Error('项目 ID 或位置参数无效')
  if (values.archived && values.deleted || (object !== 'project' || action !== 'list') && (values.archived || values.deleted))
    throw new Error('归档和回收站筛选只能在列表中单独使用')
  if (action === 'delete' && !values.yes) throw new Error('移入回收站需要显式传入 --yes')
  const requiresFields = needsFields(object, action)
  if (requiresFields !== (values.fields !== undefined)) throw new Error('请按命令要求传入 --fields JSON')
  let fields: Record<string, unknown> | undefined
  if (values.fields !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(values.fields) } catch { throw new Error('--fields 需要有效的 JSON 对象') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--fields 需要 JSON 对象')
    fields = parsed as Record<string, unknown>
  }

  let port = process.env.GUGU_DESKTOP_CLI_PORT
  let token = process.env.GUGU_DESKTOP_CLI_TOKEN
  const connectionFile = process.env.GUGU_DESKTOP_CLI_CONNECTION
  if (!port && !token && connectionFile) {
    try {
      const connection = JSON.parse(readFileSync(connectionFile, 'utf8'))
      process.kill(connection.pid, 0)
      port = String(connection.port)
      token = connection.token
    } catch {
      throw new Error('请先启动咕咕 Desktop')
    }
  }
  const send = createDesktopClient(port ?? '', token ?? '')
  const path = needsId ? '/' + id : ''
  if (values.offset !== undefined && (object !== 'project' || action !== 'list' ||
      !/^\d+$/.test(values.offset) || !Number.isSafeInteger(Number(values.offset))))
    throw new Error('--offset 仅用于 Desktop 项目列表，必须为非负整数')
  const query = values.archived ? '?archived=true' : values.deleted ? '?deleted=true' : ''
  const methods: Record<string, string> = { list: 'GET', get: 'GET', create: 'POST', update: 'PATCH', delete: 'DELETE', restore: 'POST', items: 'GET', relations: 'GET' }
  const method = methods[action]
  const result = await send((object === 'project' ? 'projects' : object) + path + (['restore', 'items', 'relations'].includes(action) ? '/' + action : query + (values.offset === undefined ? '' : (query ? '&' : '?') + 'offset=' + values.offset)), method, fields)
  console.log(JSON.stringify(result))
  if (!result.ok) process.exitCode = result.error.code === 'result_unknown' ? 3 : 1
}

main().catch(error => {
  console.log(JSON.stringify({ version: 1, ok: false, data: null, error: {
    code: 'invalid_request', message: error instanceof TypeError ? '服务地址或命令参数无效' : error.message,
  } }))
  process.exitCode = 2
})
