// 渲染各概念稿到 16/32/48/128 PNG（Chrome MV3 图标规格）
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const concepts = ['v2d-flow', 'play-down', 'disk-cloud', 'tray', 'film-strip', 'v-arrow']
const sizes = [16, 32, 48, 128]

for (const c of concepts) {
  const svg = readFileSync(join(root, 'src', `${c}.svg`), 'utf8')
  mkdirSync(join(root, c), { recursive: true })
  for (const size of sizes) {
    const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
    writeFileSync(join(root, c, `${size}.png`), r.render().asPng())
  }
  console.log(`ok: ${c} → ${sizes.join('/')}`)
}
