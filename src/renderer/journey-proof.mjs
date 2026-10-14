import assert from 'node:assert/strict'
import process from 'node:process'
import { createServer as createPortServer } from 'node:net'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const port = await new Promise((resolvePort, reject) => {
  const probe = createPortServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => resolvePort(address.port))
  })
})
const server = await createServer({ configFile: resolve(root, 'vite.renderer.config.ts'), server: { host: '127.0.0.1', port, strictPort: true } })
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
  assert.equal(await page.getByRole('switch', { name: 'Luz do quarto' }).isChecked(), true)
  await page.getByRole('slider', { name: 'Brilho' }).fill('55')
  await page.getByRole('button', { name: 'Cor' }).click()
  await page.getByLabel('Escolher cor').fill('#ff0000')
  assert.equal(await page.getByLabel('Escolher cor').inputValue(), '#ff0000')
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
  await page.getByRole('button', { name: 'Modo' }).click()
  await page.getByRole('button', { name: 'Seco' }).click()
  await page.getByRole('button', { name: 'Modo' }).getByText('Seco').waitFor()
  await page.getByRole('button', { name: 'Ventilação' }).click()
  await page.getByRole('button', { name: 'Alta' }).click()
  await page.getByRole('button', { name: 'Ventilação' }).getByText('Alta').waitFor()
  await page.getByRole('switch', { name: 'Turbo' }).click()
  assert.equal(await page.getByRole('switch', { name: 'Turbo' }).isChecked(), true)
  await page.getByText('Atualizado').waitFor()
  process.stdout.write('tray-control-ac: passed (power, temperature, mode, fan and turbo)\n')

  await page.goto(`http://127.0.0.1:${address.port}/?fixture=empty`)
  await page.getByRole('heading', { name: 'Configurar' }).waitFor()
  await page.getByRole('status', { name: 'Token LG' }).waitFor()
  await page.getByRole('status', { name: 'Chaves Tuya' }).waitFor()
  await page.getByRole('textbox', { name: 'Smart Life User Code' }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: 'Smart Life User Code' }).inputValue(), '')
  await page.getByRole('button', { name: 'Gerar QR Smart Life' }).click()
  await page.getByRole('img', { name: 'QR Smart Life' }).waitFor()
  await page.getByRole('button', { name: 'Buscar dispositivos' }).click()
  const devices = page.getByRole('list', { name: 'Dispositivos encontrados' })
  await devices.waitFor()
  assert.equal(await devices.getByRole('listitem').count() > 0, true)
  await devices.getByText('Bedroom AC').waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Cômodo de Bedroom AC' }).inputValue(), 'lg:Sem cômodo')
  await page.getByRole('combobox', { name: 'Cômodo de Bedroom AC' }).selectOption({ label: 'Office' })
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await page.getByText('Bedroom AC').waitFor()
  process.stdout.write('tray-first-setup: passed (fixture, free port)\n')

  await page.addInitScript(() => {
    const room = { id: 'offline-room', name: 'Entrada', lights: [{ id: 'offline-light', name: 'Luz Entrada', state: { on: false, online: false } }], acs: [] }
    globalThis.api = {
      getRooms: async () => [room],
      sendCommand: async () => { throw new Error('Offline light must not receive a command') },
      getLaunchAtLogin: async () => false,
      setLaunchAtLogin: async () => {},
      getSetupStatus: async () => ({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true, smartLifeUserCodeConfigured: false })
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole('button', { name: 'Luzes Entrada' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Luzes Entrada' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Abrir Entrada' }).click()
  await page.getByText('Offline', { exact: true }).waitFor()
  assert.equal(await page.getByRole('switch', { name: 'Luz Entrada' }).isDisabled(), true)
  process.stdout.write('offline-light: passed (room and device controls disabled)\n')
} finally {
  await browser?.close()
  await server.close()
}
