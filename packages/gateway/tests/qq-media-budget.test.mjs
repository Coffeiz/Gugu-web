import assert from 'node:assert/strict'
import test from 'node:test'
import { processQqMedia, QqMediaIngressError } from '../dist/platforms/qq/media-download.js'
import { createImMediaBudget } from '../dist/runtime/media-budget.js'

const signal = new AbortController().signal

function transportOf(size) {
  return {
    transport: {
      request: async () => ({
        status: 200,
        headers: {},
        body: (async function* () { yield Buffer.alloc(size, 7) })(),
        cancel() {},
      }),
    },
    resolve: async () => [{ address: '9.9.9.9', family: 4 }],
  }
}

const direct = (index) => ({
  source: 'message', attachmentIndex: index, sourcePlatformMessageId: null,
  item: { url: `https://cdn.example.test/${index}`, filename: `${index}.jpg`, content_type: 'image/jpeg' },
})
const quoted = () => ({
  source: 'quote', attachmentIndex: 0, sourcePlatformMessageId: 'msg-1',
  item: { url: 'https://cdn.example.test/quoted', filename: 'quoted.jpg', content_type: 'image/jpeg' },
})

test('直传附件按单文件上限判断：两个各 400 字节的文件在 1KB 批次内都会被接收', async () => {
  const budget = createImMediaBudget(1024, 4, 512)
  const received = []
  await processQqMedia([direct(0), direct(1)], budget, signal, {
    ...transportOf(400),
    quote: async () => false,
    file: async (_media, file) => { received.push(file.bytes.byteLength) },
  })
  assert.deepEqual(received, [400, 400])
})

test('引用附件超出单文件上限时保留消息并标记未载入，不再整条丢弃', async () => {
  const budget = createImMediaBudget(1024, 4, 512)
  let oversize = 0
  const received = []
  const processed = await processQqMedia([quoted()], budget, signal, {
    ...transportOf(1024),
    quotedOversize: () => { oversize += 1 },
    quote: async () => false,
    file: async (_media, file) => { received.push(file.bytes.byteLength) },
  })
  assert.equal(processed, true)
  assert.equal(oversize, 1)
  assert.deepEqual(received, [])
})

test('直传附件超出单文件上限时整批失败并给出 qq_media_size', async () => {
  const budget = createImMediaBudget(1024, 4, 512)
  await assert.rejects(processQqMedia([direct(0)], budget, signal, {
    ...transportOf(1024),
    quote: async () => false,
    file: async () => {},
  }), error => error instanceof QqMediaIngressError && error.code === 'qq_media_size')
})

test('引用 MOV 在原附件无法复用时下载并交给入库', async () => {
  const media = quoted()
  media.item.filename = 'clip.mov'
  media.item.content_type = 'video/quicktime'
  const received = []
  await processQqMedia([media], createImMediaBudget(1024, 4, 512), signal, {
    ...transportOf(400),
    quote: async () => false,
    file: async (_media, file) => { received.push([file.ext, file.mime, file.bytes.byteLength, file.quoted]) },
  })
  assert.deepEqual(received, [['mov', 'video/quicktime', 400, true]])
})
