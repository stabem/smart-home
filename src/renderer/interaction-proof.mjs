import assert from 'node:assert/strict'
import process from 'node:process'
import { createServer as createPortServer } from 'node:net'
import { mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const output = resolve(root, 'test-results/issue-50')
await mkdir(output, { recursive: true })
const port = await new Promise((done, reject) => {
  const probe = createPortServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => done(address.port)) })
})
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 420, height: 640 }, recordVideo: { dir: output, size: { width: 420, height: 640 } } })
  const page = await context.newPage()
  const video = page.video()
  const base = `http://127.0.0.1:${port}`
  await page.goto(`${base}/?fixture=house&latency=1500`)
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  await page.waitForTimeout(1000)
  const sala = page.getByRole('button', { name: 'Luzes Sala de estar' })
  await sala.click()
  await page.getByRole('status', { name: 'Sala de estar luzes ligadas' }).waitFor()
  await page.waitForTimeout(1800)
  await sala.click()
  await page.waitForTimeout(1800)
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await page.getByRole('heading', { name: 'Office' }).waitFor()
  await page.waitForTimeout(700)
  const group = page.getByRole('switch', { name: /Trilho do Office|Office \(trilho\)/ })
  await group.click()
  assert.equal(await group.isChecked(), true)
  await page.waitForTimeout(1900)
  await page.goto(`${base}/?fixture=house&latency=8500`)
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  await page.getByRole('button', { name: 'Luzes Entrada' }).click()
  await page.getByText('Ainda esperando a lâmpada…').waitFor({ timeout: 4000 })
  await page.getByText('A nuvem está lenta hoje…').waitFor({ timeout: 4500 })
  await page.waitForTimeout(700)
  await page.goto(`${base}/?fixture=empty&latency=1500`)
  await page.getByRole('heading', { name: 'Configurar' }).waitFor()
  await page.getByRole('button', { name: 'Buscar dispositivos' }).click()
  await page.getByText('Procurando na sua rede').waitFor()
  await page.getByText('Perguntando à nuvem').waitFor()
  const axe = await new AxeBuilder({ page }).analyze()
  assert.deepEqual(axe.violations.filter(item => item.impact === 'serious' || item.impact === 'critical').map(item => item.id), [])
  await page.getByText('Organizando os cômodos').waitFor()
  await page.getByRole('list', { name: 'Dispositivos encontrados' }).waitFor()
  await page.waitForTimeout(1000)
  await context.close()
  await rename(await video.path(), resolve(output, 'interaction.webm'))
  process.stdout.write(`interaction proof passed: ${resolve(output, 'interaction.webm')}\n`)
} finally {
  await browser?.close()
  await server.close()
}
