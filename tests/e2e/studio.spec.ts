import { expect, test } from '@playwright/test'

const installWebMcp = () => {
  const tools: Record<string, unknown> = {}
  const descriptors: Array<{ name: string; description?: string }> = []
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool: async (tool: { name: string; description?: string }) => {
        tools[tool.name] = tool
        descriptors.push({ name: tool.name, description: tool.description })
      },
      getTools: async () => descriptors,
    },
  })
  Object.defineProperty(window, '__floorTools', { value: tools })
}

test('shows 2D, 3D, Render, component rail, and truthful unsupported state', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The full header and catalog assertion is desktop-only.')
  await page.goto('')
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Metric spatial plan' })).toBeVisible()
  for (const tab of ['2D', '3D', 'RENDER']) await expect(page.getByRole('tab', { name: tab })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '2D component library' })).toBeVisible()
  for (const item of ['Round Table', 'Dining Table', 'Sofa', 'Armchair', 'Bed', 'Wardrobe', 'Kitchen Island', 'Plant'])
    await expect(page.getByRole('button', { name: new RegExp(item) })).toBeVisible()
  for (const removed of ['Spatial plan', 'Image output', 'Source of truth', 'Current change', 'Latest output'])
    await expect(page.getByText(removed, { exact: true })).toHaveCount(0)
})

test('runs approval, UI render job, WebMCP claim, verified upload, and export', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One complete desktop flow is sufficient.')
  await page.addInitScript(installWebMcp)
  await page.goto('')
  await expect(page.getByText('17/17 · Connected')).toBeVisible()
  const prepared = await page.evaluate(async () => {
    type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
    const context = await tools['floor.get_context'].execute({})
    const begun = await tools['floor.begin_change'].execute({ baseRevision: context.revision })
    await tools['floor.apply_style'].execute({
      styles: [
        {
          roomId: 'room_living',
          floorMaterial: 'warm oak',
          wallFinish: 'mineral plaster',
          ceilingHeightMm: 2900,
          palette: ['#d6b48c'],
          renderStyle: 'calm editorial',
        },
      ],
    })
    await tools['floor.validate_change'].execute({})
    await tools['floor.present_change'].execute({})
    return begun
  })
  await expect(page.locator('.project-state')).toHaveText('draft')
  await expect(page.getByLabel('Project version')).toBeDisabled()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('.project-state')).toHaveText('saved')
  await expect(page.getByLabel('Project version')).toHaveValue('4')

  await page.getByRole('button', { name: 'Render', exact: true }).click()
  await expect(page.getByText('Queued for Codex')).toBeVisible()
  const result = await page.evaluate(
    async ({ changeId }) => {
      type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
      const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
      const status = await tools['floor.get_change_status'].execute({ changeId })
      const queued = await tools['floor.get_render_job'].execute({})
      const render = await tools['floor.claim_render_job'].execute({ ticketId: queued.ticketId })
      const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      const binary = atob(base64)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      await tools['floor.preview_begin'].execute({
        ticketId: render.ticketId,
        mimeType: 'image/png',
        checksum: digest,
        expectedBytes: bytes.length,
      })
      await tools['floor.preview_chunk'].execute({ ticketId: render.ticketId, index: 0, base64 })
      const preview = await tools['floor.preview_commit'].execute({ ticketId: render.ticketId })
      return { status, render, preview }
    },
    { changeId: prepared.changeId },
  )
  expect(result.status).toMatchObject({ status: 'saved', resultRevision: 4 })
  expect(result.render).toMatchObject({
    sourcePlanRevision: 4,
    renderMode: '2d',
    captureTarget: '[data-capture-target="plan-2d"]',
  })
  expect(result.preview).toMatchObject({ sourcePlanRevision: 4 })
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export current rendered image' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('courtyard-house-v4-2d.png')
})

test('version selector previews history read-only and keeps newest first', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Version behavior is desktop-only.')
  await page.addInitScript(installWebMcp)
  await page.goto('')
  await page.evaluate(async () => {
    type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
    await tools['floor.begin_change'].execute({ baseRevision: 3 })
    await tools['floor.apply_style'].execute({
      styles: [
        {
          roomId: 'room_living',
          floorMaterial: 'oak',
          wallFinish: 'plaster',
          ceilingHeightMm: 2850,
          palette: [],
          renderStyle: 'quiet',
        },
      ],
    })
    await tools['floor.present_change'].execute({})
  })
  await page.getByRole('button', { name: 'Approve' }).click()
  const select = page.getByLabel('Project version')
  await expect(select.locator('option').first()).toContainText('v4 · Latest')
  await select.selectOption('3')
  await expect(page.getByText('Viewing v3')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Render', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Return to latest' }).click()
  await expect(select).toHaveValue('4')
})

test('switches between technical 2D, Three.js 3D, and simple Render output', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Canvas switching is covered once.')
  await page.goto('')
  await expect(page.locator('[data-capture-target="plan-2d"]')).toBeVisible()
  await page.getByRole('button', { name: /Dining Table/ }).click()
  await expect(page.getByRole('button', { name: /Dining Table/ })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: '3D' }).click()
  await expect(page.locator('[data-capture-target="scene-3d"]')).toBeVisible()
  await page.getByRole('tab', { name: 'RENDER' }).click()
  await expect(page.getByRole('region', { name: 'Rendered image output' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '2D component library' })).toHaveCount(0)
  await page.getByRole('button', { name: '3D', exact: true }).last().click()
  await expect(page.getByText('Isometric floor render')).toBeVisible()
})

test('information drawer uses the live render-job catalog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Drawer inventory is covered once.')
  await page.addInitScript(installWebMcp)
  await page.goto('')
  await page.getByRole('button', { name: 'How to use Floor Studio' }).click()
  const drawer = page.getByRole('complementary', { name: 'How to use Floor Studio' })
  await expect(drawer.getByText('17/17')).toBeVisible()
  await expect(drawer.locator('.tool-inventory article')).toHaveCount(17)
  await expect(drawer.getByText('floor.get_render_job', { exact: true })).toBeVisible()
  await expect(drawer.getByText('floor.claim_render_job', { exact: true })).toBeVisible()
  await expect(drawer.getByText('floor.prepare_render', { exact: true })).toHaveCount(0)
})

test('export opens Render empty state instead of downloading JSON', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Export behavior is covered once.')
  await page.goto('')
  await page.getByRole('button', { name: 'Export current rendered image' }).click()
  await expect(page.getByRole('tab', { name: 'RENDER' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('No ready render exists for this version and mode.')).toBeVisible()
})

test('tablet timeline is an explicit overlay', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet', 'Tablet-only responsive behavior.')
  await page.goto('')
  await page.getByRole('button', { name: 'Show Codex timeline' }).click()
  await expect(page.getByRole('button', { name: 'Hide Codex timeline' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide Codex timeline' }).click()
  await expect(page.getByRole('button', { name: 'Show Codex timeline' })).toBeVisible()
})

test('mobile keeps human approval usable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-review', 'Mobile-only responsive behavior.')
  await page.addInitScript(installWebMcp)
  await page.goto('')
  await page.evaluate(async () => {
    type Tool = { execute: (input: Record<string, unknown>) => Promise<unknown> }
    const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
    await tools['floor.begin_change'].execute({ baseRevision: 3 })
    await tools['floor.apply_style'].execute({
      styles: [
        {
          roomId: 'room_living',
          floorMaterial: 'warm oak',
          wallFinish: 'mineral plaster',
          ceilingHeightMm: 2900,
          palette: ['#d6b48c'],
          renderStyle: 'calm',
        },
      ],
    })
    await tools['floor.present_change'].execute({})
  })
  await page.getByRole('button', { name: 'Show Codex timeline' }).click()
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
})

test('matches the accepted desktop shell visual', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One visual baseline is intentional.')
  await page.addInitScript(installWebMcp)
  await page.goto('')
  await expect(page.locator('[data-capture-target="plan-2d"]')).toBeVisible()
  await page.waitForTimeout(400)
  await expect(page).toHaveScreenshot('agent-native-shell.png', { animations: 'disabled', maxDiffPixelRatio: 0.03 })
})
