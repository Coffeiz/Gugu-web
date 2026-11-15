import { openSqliteRuntime } from '../../src/data/sqlite.js'
import { createUndoStateMachine, createRuntimeUndoTransactionPort } from '../../src/undo/state-machine.js'
const { runtime, ownerId } = await openSqliteRuntime(process.argv[2]!)
const api = createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => {})
process.on('message', async message => {
  if (message === 'locked') process.send?.({ started: true })
  try { const result = await api.apply(ownerId, 'race', 'race', 'undo'); process.send?.({ idempotent: result.idempotent, events: result.events.length }) }
  catch (error) { process.send?.({ error: String(error) }) }
  finally { await runtime.close(); process.disconnect?.() }
})
process.send?.({ ready: true })
