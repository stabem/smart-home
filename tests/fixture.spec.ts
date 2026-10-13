import { test, expect } from '@playwright/test'

test('house fixture opens with the documented rooms', async ({ page }) => {
  await page.goto('/?fixture=house')
  await expect(page.getByRole('heading', { name: 'Casa' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Cômodos' }).getByRole('listitem')).toHaveCount(8)
  await page.getByRole('button', { name: 'Luzes Sala de estar' }).click()
  await expect(page.getByRole('status', { name: 'Sala de estar luzes ligadas' })).toBeAttached()
  await page.getByRole('button', { name: 'Abrir Office' }).click()
  await expect(page.getByRole('heading', { name: 'Office' })).toBeVisible()
})
