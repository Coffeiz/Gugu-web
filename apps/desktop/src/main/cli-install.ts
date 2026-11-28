import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Server } from 'node:http'

const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"

export async function publishCliConnection(server: Server, directory: string, token: string) {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无可用的 CLI 端口')
  const staging = await mkdtemp(join(directory, '.cli-'))
  const destination = join(directory, 'cli-connection.json')
  try {
    await writeFile(join(staging, 'connection.json'), JSON.stringify({
      port: address.port, token, pid: process.pid,
    }), { mode: 0o600 })
    await rename(join(staging, 'connection.json'), destination)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return destination
}

export async function registerMacCli(home: string, resources: string, connectionFile: string) {
  const directory = join(home, '.local', 'bin')
  await mkdir(directory, { recursive: true })
  const script = [
    '#!/bin/sh',
    'unset NODE_OPTIONS NODE_PATH',
    'export GUGU_DESKTOP_CLI_CONNECTION=' + shellQuote(connectionFile),
    'exec ' + shellQuote(join(resources, 'core-sidecar', 'node')) + ' ' +
      shellQuote(join(resources, 'app.asar.unpacked', 'dist', 'cli', 'gugu.cjs')) + ' "$@"',
    '',
  ].join('\n')
  try {
    await writeFile(join(directory, 'gugu'), script, { mode: 0o755, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
