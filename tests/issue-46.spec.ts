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
      documentHeight: document.documentElement.scrollHeight }
  })
  expect(geometry.height).toBe(92)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.shellBottom - 12)
  expect(geometry.overflow).toBe('hidden')
  expect(geometry.documentHeight).toBe(640)
  await page.screenshot({ path: 'test-results/design/house10.png' })
})
