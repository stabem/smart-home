import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createServer as createPortServer } from 'node:net'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const output = resolve(root, 'test-results/design')
const port = await new Promise((resolvePort, reject) => {
  const probe = createPortServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => resolvePort(address.port))
  })
})
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port, strictPort: true } })
await mkdir(output, { recursive: true })
let browser
try {
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 420, height: 640 }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const visit = async fixture => {
      await page.goto(`${base}/?fixture=${fixture}`)
      await page.addStyleTag({ content: `html,body,#root{min-height:100%}body{background:radial-gradient(circle at 16% 18%,#cfdae2 0,transparent 40%),radial-gradient(circle at 85% 78%,#d8b9af 0,transparent 42%),linear-gradient(135deg,#ece8e1,#c6d0d7 55%,#b8c2ca)}` })
      await page.evaluate(() => globalThis.document.fonts.ready)
    }
    const capture = async name => {
      const result = await new AxeBuilder({ page }).analyze()
      assert.deepEqual(result.violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })), [], `${theme} ${name}: axe`)
      await page.screenshot({ path: resolve(output, `${name === 'setup' ? 'setup' : `${theme}-${name}`}.png`), fullPage: false })
    }
    await visit('house')
    await page.getByRole('heading', { name: 'Casa' }).waitFor()
    assert.equal(await page.getByRole('list', { name: 'Cômodos' }).getByRole('listitem').count(), 8)
    await page.getByRole('button', { name: 'Luzes Sala de estar' }).click()
    await page.getByRole('status', { name: 'Sala de estar luzes ligadas' }).waitFor()
    const homeFit = await page.evaluate(() => {
      const shell = globalThis.document.querySelector('.homeScreen').getBoundingClientRect()
      const tiles = [...globalThis.document.querySelectorAll('.roomTile')]
      const buttons = [...globalThis.document.querySelectorAll('.roomLights')]
      return { scrollHeight: globalThis.document.documentElement.scrollHeight, shellBottom: shell.bottom,
        lastTileBottom: Math.max(...tiles.map(tile => tile.getBoundingClientRect().bottom)),
        lastButtonBottom: Math.max(...buttons.map(button => button.getBoundingClientRect().bottom)) }
    })
    assert.ok(homeFit.scrollHeight <= 640 && homeFit.shellBottom <= 640 && homeFit.lastTileBottom <= 620 && homeFit.lastButtonBottom <= 620,
      `${theme} home must fit the 420x640 popup with bottom breathing room: ${JSON.stringify(homeFit)}`)
    if (theme === 'light') {
      await capture('home')
      await page.getByRole('button', { name: 'Abrir Office' }).click()
      await page.getByRole('heading', { name: 'Office' }).waitFor()
      await page.screenshot({ path: resolve(output, 'office.png') })
      await page.getByRole('button', { name: 'Voltar' }).click()
      await page.getByRole('button', { name: 'Abrir Quarto' }).click()
      await page.getByRole('heading', { name: 'Quarto' }).waitFor()
      await page.screenshot({ path: resolve(output, 'quarto.png') })
      await page.getByRole('switch', { name: 'Luz do quarto' }).click()
      await page.getByRole('button', { name: 'Cor' }).click()
      await capture('room')
      await visit('house&ac-error=1')
      await page.getByRole('button', { name: 'Abrir Office' }).click()
      await page.getByRole('button', { name: 'Ligar ar' }).click()
      await page.locator('.acError').getByText('Ar não respondeu. Tente novamente.').waitFor()
      await page.screenshot({ path: resolve(output, 'ac-error.png') })
    } else {
      await page.getByRole('button', { name: 'Abrir Office' }).click()
      await page.getByRole('button', { name: 'Ligar ar' }).click()
      await page.getByRole('button', { name: 'Desligar ar' }).waitFor()
      await page.getByRole('button', { name: 'Voltar' }).click()
      await capture('home')
      await page.getByRole('button', { name: 'Abrir Office' }).click()
      await capture('ac-on')
    }
    if (theme === 'light') {
      await visit('empty')
      await page.getByRole('heading', { name: 'Configurar' }).waitFor()
      await capture('setup')
    }
    await page.keyboard.press('Tab')
    assert.ok(await page.locator(':focus-visible').count() > 0, 'keyboard focus is visible')
    assert.deepEqual(errors, [], `${theme}: browser errors`)
    await context.close()
  }
  const context = await browser.newContext({ reducedMotion: 'no-preference' })
  const page = await context.newPage()
  await page.goto(`${base}/?fixture=house`)
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  const idleFrames = await page.evaluate(async () => {
    let count = 0
    const original = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = callback => { count++; return original(callback) }
    await new Promise(resolve => globalThis.setTimeout(resolve, 1000))
    globalThis.requestAnimationFrame = original
    return count
  })
  assert.equal(idleFrames, 0, 'idle home schedules no animation frames')
  await context.close()
  process.stdout.write('Design screenshots, axe, focus and idle render: passed\n')
} finally {
  await browser?.close()
  await server.close()
}
