import { expect, test } from '@playwright/test'

test('ten rooms fit home without a scrollbar at 420 px', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 640 })
  await page.goto('/?fixture=house10')
  await expect(page.getByRole('heading', { name: 'Casa' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Cômodos' }).getByRole('listitem')).toHaveCount(10)
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.homeScreen')!
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.roomTile'))
    return { height: tiles[0].getBoundingClientRect().height, bottom: tiles.at(-1)!.getBoundingClientRect().bottom,
      shellBottom: shell.getBoundingClientRect().bottom, overflow: getComputedStyle(shell).overflowY,
      scrollHeight: shell.scrollHeight, clientHeight: shell.clientHeight,
      documentHeight: document.documentElement.scrollHeight }
  })
  expect(geometry.height).toBe(92)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.shellBottom - 12)
  expect(geometry.overflow).toBe('auto')
  expect(geometry.scrollHeight).toBe(geometry.clientHeight)
  expect(geometry.documentHeight).toBe(640)
  await page.screenshot({ path: 'test-results/design/house10.png' })
})

test('Smart Life QR stays reachable when its content exceeds the window', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 640 })
  await page.goto('/?fixture=house10&session=missing')
  await page.getByRole('button', { name: 'Reconectar Smart Life' }).click()
  await page.getByRole('button', { name: 'Gerar QR Smart Life' }).click()
  const finish = page.getByRole('button', { name: 'Concluir reconexão' })
  await expect(finish).toBeVisible()
  await finish.scrollIntoViewIfNeeded()
  const fit = await page.evaluate(() => {
    const home = document.querySelector<HTMLElement>('.homeScreen')!
    const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent === 'Concluir reconexão')!
    return { scrollHeight: home.scrollHeight, clientHeight: home.clientHeight,
      buttonBottom: button.getBoundingClientRect().bottom, windowHeight: innerHeight }
  })
  expect(fit.scrollHeight).toBeGreaterThan(fit.clientHeight)
  expect(fit.buttonBottom).toBeLessThanOrEqual(fit.windowHeight)
})
