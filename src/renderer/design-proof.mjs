import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer as createPortServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import process from 'node:process'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const output = resolve(root, 'test-results/design')
const reference = resolve(output, 'reference/macos-ventura-control-center.jpg')
const port = await new Promise((done, fail) => {
  const socket = createPortServer()
  socket.once('error', fail)
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address()
    socket.close(() => done(address.port))
  })
})
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port, strictPort: true } })
await mkdir(output, { recursive: true })
let browser
try {
  await server.listen()
  const base = `http://127.0.0.1:${port}`
  browser = await chromium.launch({ headless: true })
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 420, height: 640 }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const visit = async fixture => {
      await page.goto(`${base}/?fixture=${fixture}`)
      await page.evaluate(() => globalThis.document.fonts.ready)
    }
    const capture = async name => {
      const axe = await new AxeBuilder({ page }).analyze()
      assert.deepEqual(axe.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), [], `${theme} ${name}: axe`)
      const geometry = await page.evaluate(() => {
        const rect = element => {
          const { top, right, bottom, left } = element.getBoundingClientRect()
          return { top, right, bottom, left }
        }
        const modules = [...globalThis.document.querySelectorAll('.roomControls > section')].map(rect)
        const tiles = [...globalThis.document.querySelectorAll('.roomTile')].map(rect)
        const shell = globalThis.document.querySelector('.shell')
        return { modules, tiles, shell: rect(shell), documentHeight: globalThis.document.documentElement.scrollHeight,
          bulbs: [...globalThis.document.querySelectorAll('.roomTile .lampSymbol')].length,
          tileControls: [...globalThis.document.querySelectorAll('.roomTile .roomLights')].length,
          titleSurface: globalThis.document.querySelectorAll('.roomTitle .sharedRoomSurface').length }
      })
      assert.equal(geometry.documentHeight, 640, `${theme} ${name}: viewport height`)
      assert.equal(geometry.titleSurface, 0, `${theme} ${name}: plain room heading`)
      if (name === 'home') {
        assert.equal(geometry.tiles.length, 8)
        assert.equal(geometry.bulbs, 8, 'one bulb glyph per tile')
        assert.equal(geometry.tileControls, 8, 'one light control per tile')
        assert.ok(geometry.tiles.every(tile => tile.bottom <= 620 && tile.left >= 0 && tile.right <= 420), `${theme}: home tiles fit`)
      } else if (name !== 'setup') {
        assert.ok(geometry.modules.every((module, index) => index === 0 || module.top >= geometry.modules[index - 1].bottom - .5), `${theme} ${name}: module overlap`)
        assert.ok(geometry.modules.every(module => module.left >= 0 && module.right <= 420), `${theme} ${name}: module horizontal fit`)
      }
      await page.screenshot({ path: resolve(output, `${theme}-${name}.png`) })
    }
    await visit('house')
    await page.getByRole('heading', { name: 'Casa' }).waitFor()
    await capture('home')
    await page.getByRole('button', { name: 'Abrir Office' }).click()
    await page.getByRole('heading', { name: 'Office' }).waitFor()
    await capture('office')
    await page.getByRole('button', { name: 'Ligar ar' }).click()
    await page.getByRole('button', { name: 'Desligar ar' }).waitFor()
    await capture('ac-on')
    await visit('empty')
    await page.getByRole('heading', { name: 'Configurar' }).waitFor()
    await capture('setup')
    assert.deepEqual(errors, [], `${theme}: browser errors`)
    await context.close()
  }
  const comparison = await browser.newContext({ viewport: { width: 920, height: 700 }, deviceScaleFactor: 1 })
  const page = await comparison.newPage()
  const official = (await readFile(reference)).toString('base64')
  const result = (await readFile(resolve(output, 'light-home.png'))).toString('base64')
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:16px;background:#e7e9ed;color:#25262d;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}.pair{display:flex;align-items:flex-start;gap:16px}.frame{width:436px}.label{height:26px;font-weight:600}.image{display:flex;align-items:flex-start;justify-content:center;height:640px;overflow:hidden;border-radius:12px;background:#d8dce4}.image img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style><div class="pair"><div class="frame"><div class="label">macOS Ventura Control Center · screenshot</div><div class="image"><img src="data:image/jpeg;base64,${official}"></div></div><div class="frame"><div class="label">Smart Home · light home · 420 × 640</div><div class="image"><img src="data:image/png;base64,${result}"></div></div></div>`)
  await page.screenshot({ path: resolve(output, 'control-center-side-by-side.png') })
  await comparison.close()
  process.stdout.write(`Design proof passed: 8 screenshots, axe, geometry, composite, free port ${port}\n`)
} finally {
  await browser?.close()
  await server.close()
}
