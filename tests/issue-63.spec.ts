import { expect, test } from '@playwright/test'

const base = `http://127.0.0.1:${process.env.SMART_HOME_TEST_PORT || '5173'}`

test('a lit light breathes while on and pauses when the popup is hidden', async ({ page }) => {
  await page.goto(`${base}/?fixture=house`)
  await page.getByRole('button', { name: 'Luzes Sala de estar' }).click()
  const lit = page.locator('.roomLights[data-selected]').first()
  await expect(lit).toBeVisible()
  await expect.poll(() => lit.evaluate(el => getComputedStyle(el).animationName)).toBe('litHalo')
  await expect.poll(() => lit.evaluate(el => getComputedStyle(el).animationPlayState)).toBe('running')
  await page.evaluate(() => document.body.classList.add('hidden'))
  await expect.poll(() => lit.evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused')
})
