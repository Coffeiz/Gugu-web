import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import { acquireImHostOwnership, createImHostLifecycle, readImRuntimeOwnership, ImHostAssemblyCleanupError, type ImHostComponents, type ImHostOwnershipLease } from '../../../src/modules/im/gateway/host-runtime.js'
import { createGatewaySupervisor, GatewayConnectionCleanupError } from '../../../src/modules/im/gateway/supervisor.js'

function fixture(change?: (components: ImHostComponents) => void) {
  const calls: string[] = [], diagnostics: string[] = []
  let lose!: () => void
  const lease: ImHostOwnershipLease = { lost: new Promise<void>(resolve => { lose = resolve }), async close() { calls.push('lease:close') } }
  const service = (name: string) => ({ async start() { calls.push(`${name}:start`) }, async stop() { calls.push(`${name}:stop`) }, health: () => name })
  const components: ImHostComponents = { supervisor: service('supervisor'), worker: service('worker'), reflection: service('reflection'),
    async scanDispatch() { calls.push('dispatch') }, async recoverDeliveries() { calls.push('delivery') },
    async pumpPending() { calls.push('pending') }, async pumpInteractions() { calls.push('interaction') }, async close() { calls.push('resources:close') } }
  change?.(components)
  const runtime = createImHostLifecycle({ ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
    async acquire() { calls.push('lease:acquire'); return lease }, async components() { calls.push('resources:create'); return components }, diagnose: code => diagnostics.push(code) })
  return { runtime, components, lease, calls, diagnostics, lose: () => lose() }
}

test('保留扫描单独降级/唤醒，关闭先取消并排空维护再释放生产资源',async()=>{
  let count=0,entered!:()=>void
  const working=new Promise<void>(resolve=>entered=resolve)
  const f=fixture(components=>{components.maintain=async signal=>{
    if(++count===1)throw Error('合成维护错误')
    entered()
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
  }})
  await f.runtime.start();await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(f.runtime.health().loops.maintenance,'degraded')
  assert.ok(f.diagnostics.includes('maintenance_unavailable'));assert.equal(f.runtime.health().loops.dispatch,'running')
  f.runtime.wake('maintenance');await working
  await f.runtime.stop()
  assert.equal(f.runtime.health().loops.maintenance,'stopped')
  assert.equal(f.calls.filter(value=>value==='resources:close').length,1)
  assert.ok(f.calls.indexOf('resources:close')<f.calls.indexOf('lease:close'))
})

test('默认Python归属完全不构造Node消费者，不读取连接/配置或启动扫描', async () => {
  assert.deepEqual(readImRuntimeOwnership({}), { runtime: 'python' })
  const runtime = createImHostLifecycle({ ownership: readImRuntimeOwnership({}), async acquire() { assert.fail('Python归属不能取Node锁') },
    async components() { assert.fail('Python归属不能构造Node资源') }, diagnose() { assert.fail('默认关闭不是运行故障') } })
  await runtime.start(); await runtime.stop(); assert.equal(runtime.health().status, 'disabled')
})

test('实际生产bootstrap默认Python归属不访问PG/Core/配置/凭据，普通clear沿既有删除回调', async () => {
  const { createNodeImHostRuntime } = await import('../../../src/modules/im/gateway/bootstrap.js')
  const unreachable = new Proxy({}, { get() { assert.fail('默认Python不能触达Node生产依赖') } })
  const runtime = createNodeImHostRuntime({ environment: {}, pool: unreachable, deliveryPool: unreachable, core: unreachable,
    secretKey: 'synthetic-key', redisUrl: null, configOverridePath: 'synthetic-must-not-read.json', storageRoot: 'synthetic-must-not-read',
    promptRoot: 'synthetic-must-not-read', publicAppUrl: null, diagnose() { assert.fail('默认关闭不是错误') } } as unknown as Parameters<typeof createNodeImHostRuntime>[0])
  await runtime.start(); assert.equal(runtime.health().status, 'disabled')
  let removed = 0; await runtime.clearOwner('synthetic-owner', async () => { removed++ }); assert.equal(removed, 1)
  const ports = new Proxy({}, { get() { assert.fail('默认Python删除必须完全交还既有用例') } })
  assert.equal(await runtime.removeSession('synthetic-owner', 7, ports as Parameters<typeof runtime.removeSession>[2], async () => { removed++; return true }), true)
  assert.equal(removed, 2)
  await runtime.stop()
})

test('Node交接缺任一Python停机断言时，获取锁与组件构造前拒绝且错误不含环境原值', async () => {
  for (const flags of [{}, { IM__PYTHON_GATEWAY_STOPPED: 'true' }, { IM__PYTHON_WORKER_STOPPED: 'true' }]) {
    const runtime = createImHostLifecycle({ ownership: readImRuntimeOwnership({ IM__RUNTIME_OWNER: 'node', ...flags }),
      async acquire() { assert.fail('未交接不能取锁') }, async components() { assert.fail('未交接不能建消费者') }, diagnose() {} })
    await assert.rejects(runtime.start(), { message: 'IM 消费归属尚未切换' })
  }
  assert.throws(() => readImRuntimeOwnership({ IM__RUNTIME_OWNER: 'synthetic-private' }), { message: 'IM 消费归属配置无效' })
})

test('启动实际组件前持有唯一归属，停止先入站后消费者并排空扫描，最后释放资源与锁', async () => {
  const f = fixture(); await f.runtime.start()
  assert.equal(f.runtime.health().status, 'running')
  assert.deepEqual(f.calls.slice(0, 5), ['lease:acquire', 'resources:create', 'reflection:start', 'worker:start', 'supervisor:start'])
  assert.ok(['dispatch', 'delivery', 'pending', 'interaction'].every(name => f.calls.includes(name)))
  await f.runtime.stop(); await f.runtime.stop()
  assert.deepEqual(f.calls.slice(-5), ['supervisor:stop', 'worker:stop', 'reflection:stop', 'resources:close', 'lease:close'])
  assert.equal(f.runtime.health().status, 'stopped')
})

test('组件启动失败清理已进入start的部分资源，不暴露原始异常或遗留归属锁', async () => {
  const f = fixture(c => { c.worker.start = async () => { throw new Error('synthetic-private-start') } })
  await assert.rejects(f.runtime.start(), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'IM 运行启动未完成'); assert.doesNotMatch(JSON.stringify(error), /synthetic-private/); return true
  })
  assert.ok(f.calls.includes('worker:stop')); assert.ok(f.calls.includes('reflection:stop')); assert.equal(f.calls.at(-1), 'lease:close')
})

test('启动取得归属期间停止，迟到的锁仍释放且不继续构造消费者', async () => {
  let resolve!: (lease: ImHostOwnershipLease) => void, closed = 0
  const runtime = createImHostLifecycle({ ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
    acquire: () => new Promise<ImHostOwnershipLease>(done => { resolve = done }), async components() { assert.fail('停止后不能继续构造') }, diagnose() {} })
  const started = assert.rejects(runtime.start(), { message: 'IM 运行启动未完成' }), stopped = runtime.stop()
  resolve({ lost: new Promise(() => {}), async close() { closed++ } }); await Promise.all([started, stopped])
  assert.equal(closed, 1); assert.equal(runtime.health().status, 'stopped')
})

test('归属连接丢失停止Node消费者；清理失败保持uncertain且不主动释放有效锁给新消费者', async () => {
  const lost = fixture(); await lost.runtime.start(); lost.lose(); await new Promise(resolve => setImmediate(resolve)); await lost.runtime.stop()
  assert.equal(lost.runtime.health().status, 'stopped'); assert.ok(lost.diagnostics.includes('ownership_lost'))
  const failed = fixture(c => { c.supervisor.stop = async () => { throw new Error('synthetic-private-cleanup') } })
  await failed.runtime.start(); await assert.rejects(failed.runtime.stop(), { message: 'IM 运行资源清理未完成' })
  assert.equal(failed.runtime.health().status, 'uncertain'); assert.equal(failed.calls.includes('lease:close'), false)
  assert.ok(failed.diagnostics.includes('cleanup_failed'))
})

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL

test('装配尚未交付组件就清理失败，同样保留消费锁并暴露uncertain', async () => {
  let released = false
  const runtime = createImHostLifecycle({ ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
    acquire: async () => ({ lost: new Promise<void>(() => {}), async close() { released = true } }),
    async components() { throw new ImHostAssemblyCleanupError() }, diagnose() {} })
  await assert.rejects(runtime.start(), { message: 'IM 运行资源清理未完成' })
  assert.equal(runtime.health().status, 'uncertain'); assert.equal(released, false)
})

test('初次平台握手清理未知透传正式监督器，Host停止不得释放唯一消费锁', async () => {
  const supervisor = createGatewaySupervisor({
    async read() { return [{ key: 'feishu:synthetic', revision: '1' }] },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect() { throw new GatewayConnectionCleanupError() },
  })
  const f = fixture(components => { components.supervisor = supervisor })
  await f.runtime.start(); await supervisor.settled()
  assert.equal(supervisor.health().cleanupUnknown, 1)
  await assert.rejects(f.runtime.stop(), { message: 'IM 运行资源清理未完成' })
  assert.equal(f.runtime.health().status, 'uncertain')
  assert.equal(f.calls.includes('lease:close'), false)
  assert.ok(f.calls.includes('worker:stop')); assert.ok(f.calls.includes('resources:close'))
})
test('真实隔离PG：初次握手清理未知后Host保留锁，第二Node仍无法取得消费归属', {
  skip: !pgUrl && '需要显式隔离PG；不连接用户服务',
}, async () => {
  const { Pool } = await import('pg'), pool = new Pool({ connectionString: pgUrl, max: 3 })
  let lease: ImHostOwnershipLease | undefined
  const supervisor = createGatewaySupervisor({
    async read() { return [{ key: 'feishu:synthetic', revision: '1' }] },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} } },
    async connect() { throw new GatewayConnectionCleanupError() },
  })
  const idle = () => ({ async start() {}, async stop() {} })
  const runtime = createImHostLifecycle({
    ownership: { runtime: 'node', pythonGatewayStopped: true, pythonImConsumerStopped: true },
    async acquire() { return lease = await acquireImHostOwnership(pool) },
    async components() { return { supervisor, worker: idle(), reflection: idle(),
      async scanDispatch() {}, async recoverDeliveries() {}, async pumpPending() {}, async pumpInteractions() {}, async close() {} } },
    diagnose() {},
  })
  try {
    await runtime.start(); await supervisor.settled()
    await assert.rejects(runtime.stop(), { message: 'IM 运行资源清理未完成' })
    assert.equal(runtime.health().status, 'uncertain')
    await assert.rejects(acquireImHostOwnership(pool), { message: 'IM 消费归属锁不可用' })
  } finally {
    // 仅fixture拆除：合成connect从未创建平台资源；生产的uncertain路径不能自行放锁。
    await runtime.stop().catch(() => undefined); await lease?.close(); await pool.end()
  }
})

test('真实隔离PG归属锁：第二Node拒绝，首个释放后可接管，不更改Python或数据库内容', {
  skip: !pgUrl && '需要显式隔离PG；不连接用户服务',
}, async () => {
  const { Pool } = await import('pg'), pool = new Pool({ connectionString: pgUrl, max: 3 })
  let first: ImHostOwnershipLease | undefined, next: ImHostOwnershipLease | undefined
  try {
    first = await acquireImHostOwnership(pool)
    await assert.rejects(acquireImHostOwnership(pool), { message: 'IM 消费归属锁不可用' })
    await first.close(); first = undefined
    next = await acquireImHostOwnership(pool)
  } finally { await next?.close(); await first?.close(); await pool.end() }
})

test('真实隔离PG：独立Node进程持锁时拒绝第二消费者，强制退出后同一归属锁可重新取得',{
  skip:!pgUrl&&'需要显式隔离PG；不连接用户服务',timeout:30000,
},async()=>{
  const{Pool}=await import('pg'),pool=new Pool({connectionString:pgUrl,max:2})
  const moduleUrl=new URL('../../../src/modules/im/gateway/host-runtime.ts',import.meta.url).href
  const loader=fileURLToPath(new URL('../../../../../node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs',import.meta.url))
  // 子进程只取专属测试库中的正式归属锁；不构造Gateway/Run，也不调用优雅解锁。
  const script=`
    const {Pool}=await import(${JSON.stringify(import.meta.resolve('pg'))});
    const {acquireImHostOwnership}=await import(${JSON.stringify(moduleUrl)});
    const pool=new Pool({connectionString:process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL,max:1});
    try{await acquireImHostOwnership(pool);process.send({type:'locked'});}
    catch{process.send({type:'failed'});await pool.end();process.exitCode=1;process.disconnect();}
  `
  const child=spawn(process.execPath,['--import',loader,'--input-type=module','--eval',script],{
    windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
      ESBUILD_BINARY_PATH:process.env.ESBUILD_BINARY_PATH,NODE_PATH:process.env.NODE_PATH,GUGU_IM_GATEWAY_TEST_DATABASE_URL:pgUrl},
  })
  let exited=false,next:ImHostOwnershipLease|undefined
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    child.once('error',()=>reject(new Error('合成Node子进程启动失败')))
    child.once('exit',(code,signal)=>{exited=true;resolve({code,signal})})
  })
  // 立刻消费错误，避免ready阶段失败导致exit拒绝悬空。
  void exit.catch(()=>undefined)
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('合成Node子进程未能及时持锁')),15000)
      const message=(value:unknown)=>finish(value&&typeof value==='object'&&'type'in value&&value.type==='locked'?undefined:new Error('合成Node子进程未能持锁'))
      const early=()=>finish(new Error('合成Node子进程持锁前退出'))
      function finish(error?:Error){clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',early);child.removeListener('error',early);error?reject(error):resolve()}
      child.once('message',message);child.once('exit',early);child.once('error',early)
    })
    await assert.rejects(acquireImHostOwnership(pool),{message:'IM 消费归属锁不可用'})
    assert.equal(child.kill('SIGKILL'),true)
    const ended=await exit
    assert.ok(ended.signal==='SIGKILL'||process.platform==='win32'&&ended.code!==0,'必须实际强制终止而非调用close解锁')
    // 进程exit是接管围栏；此后同一数据库中的正式锁应可取得。
    next=await acquireImHostOwnership(pool)
  }finally{
    if(!exited){child.kill('SIGKILL');await exit.catch(()=>undefined)}
    await next?.close();await pool.end()
  }
})
