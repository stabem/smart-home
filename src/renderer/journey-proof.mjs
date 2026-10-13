import assert from 'node:assert/strict'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser
try {
  await server.listen()
  const address = server.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const url = `http://127.0.0.1:${address.port}/?fixture=house`

  await page.goto(url)
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  assert.equal(await page.getByRole('list', { name: 'Cômodos' }).getByRole('listitem').count(), 8)
  await page.getByRole('button', { name: 'Luzes Sala de estar' }).click()
  await page.getByRole('status', { name: 'Sala de estar luzes ligadas' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Luzes Sala de estar' }).getAttribute('aria-pressed'), 'true')
  process.stdout.write('tray-toggle-room-lights: passed\n')

  await page.goto(url)
  await page.getByRole('button', { name: 'Abrir Quarto' }).click()
  await page.getByRole('heading', { name: 'Quarto' }).waitFor()
  await page.getByRole('switch', { name: 'Luz do quarto' }).click()
  assert.equal(await page.getByRole('switch', { name: 'Luz do quarto' }).getAttribute('aria-checked'), 'true')
  await page.getByRole('slider', { name: 'Brilho' }).fill('55')
  await page.getByRole('button', { name: 'Cor' }).click()
  await page.getByLabel('Escolher cor').fill('#ff0000')
  await page.getByRole('status', { name: 'Cor atual' }).getByText('#ff0000').waitFor()
  await page.getByRole('slider', { name: 'Temperatura da luz' }).fill('65')
  assert.equal(await page.getByRole('slider', { name: 'Temperatura da luz' }).inputValue(), '65')
  await page.getByRole('button', { name: 'Voltar' }).click()
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  await page.getByRole('button', { name: 'Abrir Quarto' }).click()
  await page.getByRole('button', { name: 'Cor' }).click()
  assert.equal(await page.getByLabel('Escolher cor').inputValue(), '#ff0000')
  assert.equal(await page.getByRole('slider', { name: 'Temperatura da luz' }).inputValue(), '65')
  process.stdout.write('tray-adjust-light: passed (color and white temperature reflected)\n')

  await page.goto(url)
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await page.getByRole('heading', { name: 'Office' }).waitFor()
  await page.getByRole('button', { name: 'Ligar ar' }).click()
  await page.getByRole('button', { name: 'Desligar ar' }).waitFor()
  await page.getByRole('button', { name: 'Aumentar' }).click()
  assert.equal(await page.getByRole('slider', { name: 'Temperatura' }).inputValue(), '24')
  await page.getByRole('button', { name: 'Diminuir' }).click()
  assert.equal(await page.getByRole('slider', { name: 'Temperatura' }).inputValue(), '23')
  await page.getByRole('button', { name: 'Modo' }).waitFor()
  await page.getByRole('button', { name: 'Ventilação' }).waitFor()
  await page.getByRole('switch', { name: 'Turbo' }).waitFor()
  await page.getByText('Atualizado').waitFor()
  process.stdout.write('tray-control-ac: passed (mode, fan and turbo unavailable in current command contract)\n')

  await page.goto(`http://127.0.0.1:${address.port}/?fixture=empty`)
  await page.getByRole('heading', { name: 'Configurar' }).waitFor()
  await page.getByRole('status', { name: 'Token LG' }).waitFor()
  await page.getByRole('status', { name: 'Chaves Tuya' }).waitFor()
  await page.getByRole('button', { name: 'Gerar QR Smart Life' }).click()
  await page.getByRole('img', { name: 'QR Smart Life' }).waitFor()
  await page.getByRole('button', { name: 'Buscar dispositivos' }).click()
  const devices = page.getByRole('list', { name: 'Dispositivos encontrados' })
  await devices.waitFor()
  assert.equal(await devices.getByRole('listitem').count() > 0, true)
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  process.stdout.write('tray-first-setup: passed (fixture, free port)\n')
} finally {
  await browser?.close()
  await server.close()
}
