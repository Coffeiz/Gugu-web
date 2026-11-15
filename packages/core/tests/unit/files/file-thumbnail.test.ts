import assert from 'node:assert/strict'
import test from 'node:test'
import { planFileThumbnail } from '../../../src/files/read.js'

test('File thumbnail keeps full images and SVG unchanged, including MIME normalization', () => {
  assert.deepEqual(planFileThumbnail('image/jpg', 'PNG', 'full'), {
    kind: 'raw',
    mimeType: 'image/jpeg',
  })
  assert.deepEqual(planFileThumbnail('image/svg+xml', null, 'card'), {
    kind: 'raw',
    mimeType: 'image/svg+xml',
  })
})

test('File thumbnail accepts generic MIME only when image content identifies a supported format', () => {
  assert.deepEqual(planFileThumbnail('application/octet-stream', 'png', 'tiny'), {
    kind: 'resize',
    mimeType: 'image/png',
    maxDimension: 20,
    quality: 75,
  })
  assert.equal(planFileThumbnail('application/octet-stream', null, 'tiny'), null)
  assert.equal(planFileThumbnail('text/plain', 'PNG', 'tiny'), null)
})

test('File thumbnail card profile bounds the longest edge to 768 pixels', () => {
  assert.deepEqual(planFileThumbnail('image/webp', null, 'card'), {
    kind: 'resize',
    mimeType: 'image/webp',
    maxDimension: 768,
    quality: 92,
  })
})
