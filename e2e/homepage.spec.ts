import { test, expect } from '@playwright/test'

test.describe('Homepage', () => {
  test('loads successfully', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Wake/i)
  })

  test('displays main navigation', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=Copy Trading')).toBeVisible()
  })

  test('shows trader list', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=@northstar')).toBeVisible()
  })
})

test.describe('Navigation', () => {
  test('switches between tabs', async ({ page }) => {
    await page.goto('/')

    const predictTab = page.locator('text=Predict')
    await predictTab.click()
    await expect(predictTab).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('UI Elements', () => {
  test('displays wallet connect button', async ({ page }) => {
    await page.goto('/')
    const connectButton = page.locator('button:has-text("Connect")')
    await expect(connectButton).toBeVisible()
  })

  test('shows market data', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('text=BTC').first()).toBeVisible()
  })
})
