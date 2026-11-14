import { randomUUID } from 'node:crypto'
import { CoreError } from './contracts/index.js'
import { initializeSqlite, migrateSqlite } from './data/sqlite.js'
import { LocalRuntime } from './runtime/local.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2),
    databaseIndex = args.indexOf('--database')
  if (databaseIndex < 0 || !args[databaseIndex + 1])
    throw new CoreError('invalid_request', '必须提供 --database')
  const database = args[databaseIndex + 1]!
  args.splice(databaseIndex, 2)
  const operationIndex = args.indexOf('--operation-id'),
    operationId = operationIndex < 0 ? randomUUID() : args[operationIndex + 1]!
  if (operationIndex >= 0) args.splice(operationIndex, 2)
  const command = args.shift()
  if (command === 'init') {
    await initializeSqlite(database)
    console.log(JSON.stringify({ initialized: true, schema: 3 }))
    return
  }
  if (command === 'migrate') {
    const backup = await migrateSqlite(database)
    console.log(JSON.stringify({ migrated: true, backup }))
    return
  }
  const runtime = await LocalRuntime.open(database)
  try {
    let result: unknown
    if (command === 'list') result = await runtime.call('projects.list')
    else if (command === 'create' && args[0])
      result = await runtime.call('projects.create', { name: args[0] }, { operationId })
    else if (command === 'rename' && args[0] && args[1] && args.includes('--version'))
      result = await runtime.call(
        'projects.rename',
        {
          id: Number(args[0]),
          name: args[1],
          version: Number(args[args.indexOf('--version') + 1]),
        },
        { operationId },
      )
    else if (command === 'receipt' && args[0])
      result = await runtime.call('operations.get', { operation_id: args[0] })
    else throw new CoreError('invalid_request', 'Core 命令或参数无效')
    console.log(
      JSON.stringify(
        command === 'create' || command === 'rename'
          ? { operation_id: operationId, ...(result as object) }
          : result,
      ),
    )
  } finally {
    await runtime.close()
  }
}
try {
  await main()
} catch (error) {
  console.error(
    error instanceof CoreError ? error.message : 'Core 数据操作失败，请检查数据库与匹配的运行时',
  )
  process.exitCode = 2
}
