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

test('missing Smart Life session shows reconnect and keeps rooms after QR flow', async ({ page }) => {
  await page.goto('/?fixture=house&session=missing')
  await expect(page.getByRole('region', { name: 'Smart Life desconectado' })).toBeVisible()
  await page.getByRole('button', { name: 'Reconectar Smart Life' }).click()
  await page.getByRole('button', { name: 'Gerar QR Smart Life' }).click()
  await expect(page.getByRole('img', { name: 'QR Smart Life' })).toBeVisible()
  await page.getByRole('button', { name: 'Concluir reconexão' }).click()
  await expect(page.getByRole('region', { name: 'Smart Life desconectado' })).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Cômodos' }).getByRole('listitem')).toHaveCount(8)
})
