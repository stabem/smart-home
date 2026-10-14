import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

test('LG 2304 turns the AC card off before a 4 s repair read and ignores stale ON', async ({ page }) => {
  await page.addInitScript(() => {
    const room = { id: 'office', name: 'Office', lights: [], acs: [{ id: 'ac-1', name: 'Ar Office', state: { on: true, online: true, targetTemperature: 23 } }] }
    let reads = 0
    let completedReads = 0
    Object.assign(window, { acReads: () => reads, acReadsDone: () => completedReads })
    Object.assign(window, { api: {
      getRooms: async () => {
        reads++
        if (reads > 1) await new Promise(resolve => setTimeout(resolve, 4000))
        completedReads++
        return [structuredClone(room)]
      },
      sendCommand: async () => ({ ok: false, state: { on: false, online: true, targetTemperature: 23 }, error: 'O ar está desligado. Ligue primeiro.' }),
      getSetupStatus: async () => ({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: false, smartLifeUserCodeConfigured: false, smartLifeConnected: false }),
      getLaunchAtLogin: async () => false
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await expect(page.getByRole('button', { name: 'Desligar ar' })).toBeVisible()
  await page.getByRole('button', { name: 'Aumentar' }).click()
  await expect(page.getByRole('button', { name: 'Ligar ar' })).toBeVisible({ timeout: 1000 })
  await expect(page.getByRole('alert').getByText('O ar está desligado. Ligue primeiro.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { acReads: () => number }).acReads())).toBeGreaterThanOrEqual(3)
  await expect.poll(() => page.evaluate(() => {
    const status = window as unknown as { acReads: () => number; acReadsDone: () => number }
    return status.acReadsDone() === status.acReads()
  }), { timeout: 6000 }).toBe(true)
  await expect(page.getByRole('button', { name: 'Ligar ar' })).toBeVisible()
})

test('a delayed failed light command paints immediately and rolls back', async ({ page }) => {
  await page.goto('/?fixture=house&latency=1500&failure=always')
  await page.getByRole('button', { name: 'Abrir Quarto' }).click()
  const light = page.getByRole('switch', { name: 'Luz do quarto' })
  await light.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(light).toBeFocused()
  expect(await page.locator('.devicePanel .lightSwitch').first().evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await light.click()
  await expect(light).toBeChecked()
  await expect(page.getByRole('status', { name: 'Enviando comando' })).toBeVisible()
  const marks = await page.evaluate(() => {
    const entries = performance.getEntriesByType('mark').reverse()
    const intent = entries.find(entry => entry.name.endsWith(':intent'))
    const paint = entries.find(entry => entry.name.endsWith(':paint-ready'))
    return intent && paint ? paint.startTime - intent.startTime : null
  })
  expect(marks).not.toBeNull()
  expect(marks!).toBeLessThan(16)
  await expect(light).not.toBeChecked({ timeout: 3000 })
  await expect(page.getByRole('alert').getByText('Dispositivo não respondeu. Tente novamente.')).toBeVisible()
})

test('drag stays live and the last brightness value wins', async ({ page }) => {
  await page.goto('/?fixture=house&latency=1500')
  await page.getByRole('button', { name: 'Abrir Quarto' }).click()
  const slider = page.getByRole('slider', { name: 'Brilho' })
  const box = await page.locator('.brightnessSlider .sliderTrack').boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * .75, box!.y + box!.height / 2, { steps: 5 })
  await expect(slider).toHaveValue(/7[0-9]/)
  await page.mouse.up()
  await expect(page.getByRole('status', { name: 'Enviando comando' })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Enviando comando' })).toHaveCount(0, { timeout: 5000 })
  await expect(slider).toHaveValue(/7[0-9]/)
})

test('record the native control path with delayed fixture and one rollback', async ({ browser, baseURL }) => {
  await mkdir('test-results/design', { recursive: true })
  const context = await browser.newContext({ viewport: { width: 420, height: 640 }, recordVideo: { dir: 'test-results/design', size: { width: 420, height: 640 } } })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  await page.goto(`${baseURL}/?fixture=house&latency=1500&failure=once`)
  await page.getByRole('heading', { name: 'Casa' }).waitFor()
  const roomLight = page.getByRole('button', { name: 'Luzes Sala de estar' })
  await roomLight.click()
  await expect(roomLight).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('alert').getByText('Falha ao mudar as luzes')).toBeVisible({ timeout: 3000 })
  await roomLight.click()
  await expect(roomLight).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(() => {
    const samples: number[] = []
    Object.assign(window, { roomFrames: samples })
    const start = performance.now()
    const sample = (time: number) => { samples.push(time); if (time - start < 280) requestAnimationFrame(sample) }
    requestAnimationFrame(sample)
  })
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await page.getByRole('heading', { name: 'Office' }).waitFor()
  await page.waitForTimeout(320)
  const frameTimes = await page.evaluate(() => (window as unknown as { roomFrames: number[] }).roomFrames)
  const frameGaps = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b)
  expect(frameGaps.length).toBeGreaterThan(10)
  const p90FrameMs = frameGaps[Math.floor(frameGaps.length * .9)]
  const p95FrameMs = frameGaps[Math.floor(frameGaps.length * .95)]
  expect(p90FrameMs).toBeLessThan(20)
  console.log(`room transition frame p90 ${p90FrameMs.toFixed(1)} ms, p95 ${p95FrameMs.toFixed(1)} ms`)
  const track = page.locator('.brightnessSlider .sliderTrack')
  const box = await track.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * .8, box!.y + box!.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Aumentar' }).click()
  await page.getByRole('button', { name: 'Diminuir' }).click()
  await page.waitForTimeout(1800)
  await context.tracing.stop({ path: 'test-results/design/interaction-trace.zip' })
  const video = page.video()
  await context.close()
  await video?.saveAs('test-results/design/interaction.webm')
})
