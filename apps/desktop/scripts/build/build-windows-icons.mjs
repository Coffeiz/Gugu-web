import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../../../packages/charts/package.json', import.meta.url))
const { Resvg } = require('@resvg/resvg-js')
const source = readFileSync(new URL('../../../ui/public/brand/bird-solid.svg', import.meta.url), 'utf8')
const shortcutSvg = readFileSync(new URL('../../../ui/public/brand/app-icon-light.svg', import.meta.url), 'utf8')
  .replace('viewBox="0 0 168 168"', 'viewBox="7 7 154 154"')
const icons = [
  ['icon.ico', shortcutSvg],
  ...[['light', '#000'], ['dark', '#fff']].map(([theme, color]) => [
    `icon-win-${theme}.ico`,
    source.replace(/<style>[\s\S]*?<\/style>/, `<style>.bird { fill: ${color}; }</style>`),
  ]),
]
for (const [filename, svg] of icons) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const images = sizes.map(size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16
    header[entry] = header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12)
    offset += images[index].length
  })
  writeFileSync(new URL(`../../assets/${filename}`, import.meta.url), Buffer.concat([header, ...images]))
}
