import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const chartEntryPattern = /^\.\.\/\.\.\/\.\.\/\.\.\/backend\/ts\/workers\/chart-renderer\/(theme|diagram-source|svg-style)\.mjs$/u
const virtualEntryPattern = /^\0gugu-chart-renderer:(theme|diagram-source|svg-style)$/u

export function createChartRendererDevPlugin(frontendDir) {
  return {
    name: 'gugu-chart-renderer-dev-sources',
    apply: 'serve',
    enforce: 'pre',
    resolveId(id) {
      const match = chartEntryPattern.exec(id)
      return match ? `\0gugu-chart-renderer:${match[1]}` : undefined
    },
    load(id) {
      const match = virtualEntryPattern.exec(id)
      if (!match) return undefined

      const filePath = resolve(frontendDir, `../backend/ts/workers/chart-renderer/${match[1]}.mjs`)
      this.addWatchFile(filePath)
      return readFileSync(filePath, 'utf8')
    },
  }
}
