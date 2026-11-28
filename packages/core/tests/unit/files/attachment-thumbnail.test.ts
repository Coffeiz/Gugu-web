import assert from 'node:assert/strict'
import test from 'node:test'
import { planAttachmentThumbnail } from '../../../src/files/read.js'

test('attachment thumbnail hides non-images and serves SVG without rasterizing it', () => {
  assert.equal(planAttachmentThumbnail({ kind: 'file', ext: 'png', mimeType: 'image/png', qqFace: false, size: 'card' }), null)
  assert.deepEqual(planAttachmentThumbnail({ kind: 'image', ext: 'svg', mimeType: 'image/svg+xml', qqFace: false, size: 'card' }), {
    kind: 'raw', mimeType: 'image/svg+xml',
  })
})

test('attachment full size preserves GIF/WebP animation and QQ face originals', () => {
  for (const input of [
    { kind: 'image', ext: 'gif', mimeType: 'image/gif', qqFace: false, size: 'full' },
    { kind: 'image', ext: 'png', mimeType: 'image/png', qqFace: true, size: 'full' },
    { kind: 'image', ext: 'webp', mimeType: 'image/webp', qqFace: false, size: 'full' },
  ]) assert.deepEqual(planAttachmentThumbnail(input), { kind: 'raw', mimeType: input.mimeType })
})

test('attachment thumbnail uses bounded JPEG profiles and Python unknown-size default', () => {
  assert.deepEqual(planAttachmentThumbnail({ kind: 'image', ext: 'png', mimeType: 'image/png', qqFace: false, size: 'tiny' }), {
    kind: 'resize', mimeType: 'image/jpeg', maxDimension: 20, quality: 80,
  })
  assert.deepEqual(planAttachmentThumbnail({ kind: 'image', ext: 'png', mimeType: 'image/png', qqFace: false, size: 'card' }), {
    kind: 'resize', mimeType: 'image/jpeg', maxDimension: 768, quality: 80,
  })
  assert.deepEqual(planAttachmentThumbnail({ kind: 'image', ext: 'png', mimeType: 'image/png', qqFace: false, size: 'invalid' }), {
    kind: 'resize', mimeType: 'image/jpeg', maxDimension: 192, quality: 82,
  })
})
