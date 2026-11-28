import { CoreError } from '@gugu/core'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import JSZip from 'jszip'
import { MAX_COMPRESS_SOURCE_BYTES } from './rules.js'

export type ZipSource = { archivePath: string; kind: 'folder' } | { archivePath: string; kind: 'file'; open: () => Readable }

/** 将调用方已授权的输入流写成 ZIP，并限制未压缩的源数据大小。 */
export async function writeZipStreams(entries: readonly ZipSource[], outputPath: string): Promise<{ size: number; digest: string }> {
  const zip = new JSZip()
  let sourceBytes = 0
  const inputs: Readable[] = []
  let failInput!: (error: Error) => void
  const inputFailure = new Promise<never>((_resolve, reject) => { failInput = reject })
  for (const entry of entries) {
    if (entry.kind === 'folder') { zip.folder(entry.archivePath.replace(/\/$/, '')); continue }
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sourceBytes += chunk.length
      if (sourceBytes > MAX_COMPRESS_SOURCE_BYTES) return callback(new CoreError('conflict', '内容过大，暂不支持在库内压缩'))
      callback(null, chunk)
    } })
    const input = entry.open()
    inputs.push(input)
    meter.on('error', failInput)
    input.on('error', error => meter.destroy(error))
    zip.file(entry.archivePath, input.pipe(meter), { binary: true, createFolders: false })
  }
  const hash = createHash('sha256')
  let size = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    hash.update(chunk)
    callback(null, chunk)
  } })
  const zipStream = zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }) as Readable
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  try {
    await Promise.race([pipeline(zipStream, meter, output), inputFailure])
  } catch (error) {
    for (const input of inputs) input.destroy()
    zipStream.destroy()
    output.destroy()
    throw error
  }
  return { size, digest: hash.digest('hex') }
}
