import { mkdir, rename, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'

const destination = resolve('src/renderer/assets/fonts')
const fonts = [
  { family: 'Switzer', weight: 400, file: 'switzer-400.woff2' },
  { family: 'Switzer', weight: 500, file: 'switzer-500.woff2' },
  { family: 'Switzer', weight: 600, file: 'switzer-600.woff2' },
  { family: 'Zodiak', weight: 400, file: 'zodiak-400.woff2' }
]

await mkdir(destination, { recursive: true })
const faces = []
for (const font of fonts) {
  try {
    const cssUrl = new URL('https://api.fontshare.com/v2/css')
    cssUrl.searchParams.append('f[]', `${font.family.toLowerCase()}@${font.weight}`)
    cssUrl.searchParams.set('display', 'swap')
    const cssResponse = await globalThis.fetch(cssUrl, { signal: globalThis.AbortSignal.timeout(15000) })
    if (!cssResponse.ok) throw new Error('CSS request failed')
    const css = await cssResponse.text()
    const face = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)]
      .map(match => match[1])
      .find(block => block.includes(`font-family: '${font.family}'`) && block.includes(`font-weight: ${font.weight};`))
    const source = face?.match(/url\(['"]?(\/\/cdn\.fontshare\.com\/[^)'"\s]+\.woff2)['"]?\)\s*format\(['"]woff2['"]\)/)?.[1]
    if (!source) throw new Error('WOFF2 source missing')
    const fontResponse = await globalThis.fetch(`https:${source}`, { signal: globalThis.AbortSignal.timeout(15000) })
    if (!fontResponse.ok) throw new Error('font request failed')
    const bytes = Buffer.from(await fontResponse.arrayBuffer())
    if (bytes.length < 100 || bytes.length > 1_000_000 || bytes.toString('ascii', 0, 4) !== 'wOF2') throw new Error('invalid WOFF2')
    const file = resolve(destination, font.file)
    await writeFile(`${file}.tmp`, bytes)
    await rename(`${file}.tmp`, file)
    faces.push(`@font-face{font-family:'${font.family}';src:url('./${font.file}') format('woff2');font-weight:${font.weight};font-display:swap}`)
    process.stdout.write(`Fontshare ${font.family} ${font.weight}: downloaded\n`)
  } catch {
    process.stderr.write(`Fontshare ${font.family} ${font.weight}: unavailable; using system font\n`)
  }
}
await writeFile(resolve(destination, 'fonts.css'), faces.length ? `${faces.join('\n')}\n` : '/* System font fallback */\n')
