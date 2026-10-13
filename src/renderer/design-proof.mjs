import assert from 'node:assert/strict'
import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: true } })
const output = resolve(root, 'test-results/design')
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
    const check = async name => {
      await page.waitForFunction(expected => {
        const style = globalThis.getComputedStyle(globalThis.document.documentElement)
        const plaster = style.getPropertyValue('--plaster').trim().toLowerCase()
        return plaster === (expected === 'dark' ? '#1f1e1c' : '#eeebe5')
      }, theme)
      await page.evaluate(() => globalThis.document.fonts.ready)
      const result = await new AxeBuilder({ page }).analyze()
      const severe = result.violations.filter(item => ['serious', 'critical'].includes(item.impact))
      assert.deepEqual(severe.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${theme} ${name}: axe`)
      await page.screenshot({ path: resolve(output, `${theme}-${name}.png`), fullPage: true })
    }
    await page.goto(`${base}/?fixture=house`)
    await page.getByRole('heading', { name: 'Casa' }).waitFor()
    await page.locator('canvas[aria-hidden="true"]').waitFor()
    await check('home')
    const idleFrames = await page.evaluate(async () => {
      let count = 0
      const original = globalThis.requestAnimationFrame
      globalThis.requestAnimationFrame = callback => { count++; return original(callback) }
      await new Promise(resolve => globalThis.setTimeout(resolve, 1000))
      globalThis.requestAnimationFrame = original
      return count
    })
    assert.equal(idleFrames, 0, `${theme} idle home must not schedule frames with reduced motion`)
    await page.getByRole('button', { name: 'Abrir Sala de estar' }).click()
    await page.getByRole('heading', { name: 'Sala de estar' }).waitFor()
    await check('sala')
    await page.getByRole('button', { name: 'Voltar' }).click()
    await page.getByRole('button', { name: 'Abrir Office' }).click()
    await page.getByRole('heading', { name: 'Office' }).waitFor()
    await page.getByRole('button', { name: 'Ligar ar' }).click()
    await page.getByRole('button', { name: 'Desligar ar' }).waitFor()
    await check('office')
    await page.goto(`${base}/?fixture=empty`)
    await page.getByRole('heading', { name: 'Configurar' }).waitFor()
    await check('setup')
    await context.close()
  }
  const idleContext = await browser.newContext({ viewport: { width: 420, height: 640 }, reducedMotion: 'no-preference' })
  const idlePage = await idleContext.newPage()
  await idlePage.goto(`${base}/?fixture=house`)
  await idlePage.locator('canvas[aria-hidden="true"]').waitFor()
  const normalIdleFrames = await idlePage.evaluate(async () => {
    await new Promise(resolve => globalThis.setTimeout(resolve, 500))
    let count = 0
    const original = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = callback => { count++; return original(callback) }
    await new Promise(resolve => globalThis.setTimeout(resolve, 1000))
    globalThis.requestAnimationFrame = original
    return count
  })
  assert.equal(normalIdleFrames, 0, 'idle home must not schedule frames without reduced motion')
  await idlePage.evaluate(() => {
    globalThis.__cameraFrames = 0
    const original = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = callback => {
      globalThis.__cameraFrames++
      return original(callback)
    }
  })
  await idlePage.getByRole('button', { name: 'Abrir Sala de estar' }).click()
  await idlePage.getByRole('heading', { name: 'Sala de estar' }).waitFor()
  await idlePage.waitForTimeout(250)
  const zoomInFrames = await idlePage.evaluate(() => globalThis.__cameraFrames)
  assert.ok(zoomInFrames > 2, 'selecting a room must animate the camera zoom')
  await idlePage.getByRole('button', { name: 'Voltar' }).click()
  await idlePage.getByRole('heading', { name: 'Casa' }).waitFor()
  await idlePage.waitForTimeout(250)
  const zoomOutFrames = await idlePage.evaluate(() => globalThis.__cameraFrames)
  assert.ok(zoomOutFrames > zoomInFrames + 2, 'Voltar must animate the camera back out')
  await idleContext.close()
  const context = await browser.newContext({ viewport: { width: 420, height: 640 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const original = globalThis.HTMLCanvasElement.prototype.getContext
    globalThis.HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (typeof type === 'string' && type.startsWith('webgl')) return null
      return original.call(this, type, ...args)
    }
  })
  await page.goto(`${base}/?fixture=house`)
  await page.locator('svg.planFallback').waitFor()
  await page.keyboard.press('Tab')
  const visibleFocus = await page.locator(':focus-visible').count()
  assert.ok(visibleFocus > 0, 'keyboard focus must be visible')
  await page.screenshot({ path: resolve(output, 'webgl-fallback.png'), fullPage: true })
  await context.close()
  process.stdout.write('Design screenshots, axe, visible keyboard focus, reduced motion and WebGL fallback: passed\n')
} finally {
  await browser?.close()
  await server.close()
}
