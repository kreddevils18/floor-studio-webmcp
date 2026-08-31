import { expect, test } from '@playwright/test'

test('loads the viewport and tells the truth about WebMCP compatibility', async ({ page }) => {
  await page.goto('')
  await expect(page.getByText('FLOOR STUDIO')).toBeVisible()
  await expect(page.getByTestId('plan-viewport')).toBeVisible()
  await expect(page.getByText('Codex tools are not connected.')).toBeVisible()
})

test('switches to both generated previews', async ({ page }) => {
  await page.goto(''); await page.getByRole('tab', { name: '3D PREVIEWS' }).click()
  await expect(page.getByAltText('Living-room perspective preview')).toBeVisible()
  await expect(page.getByAltText('Whole-floor axonometric cutaway preview')).toBeVisible()
})

test('queues a local request without claiming connectivity', async ({ page }) => {
  await page.goto(''); const composer = page.getByLabel('Local handoff request'); await composer.fill('Move the dining table 300 mm east.'); await page.getByLabel('Queue request').click()
  await expect(composer).toHaveValue(''); await expect(page.getByLabel('Queue request')).toBeDisabled()
})

test('mobile is explicitly review-only', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-review', 'Mobile-only assertion.')
  await page.goto(''); await expect(page.getByText('Review mode')).toBeVisible(); await expect(page.getByLabel('Local handoff request')).toBeVisible(); await expect(page.getByRole('navigation', { name: 'Review tools' })).toBeHidden()
})

test('mobile can approve a presented Codex draft without construction controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-review', 'Mobile-only human approval flow.')
  await page.addInitScript(() => {
    const tools: Record<string, unknown> = {}; Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: async (tool: { name: string }) => { tools[tool.name] = tool } } }); Object.defineProperty(window, '__floorTools', { value: tools })
  })
  await page.goto('')
  await page.evaluate(async () => {
    type Tool = { execute: (input: Record<string, unknown>) => Promise<unknown> }; const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
    await tools['floor.begin_change'].execute({ baseRevision: 3 })
    await tools['floor.apply_style'].execute({ styles: [{ roomId: 'room_living', floorMaterial: 'pale oak', wallFinish: 'mineral plaster', ceilingHeightMm: 2800, palette: ['#e7e3da'], renderStyle: 'editorial' }] })
    await tools['floor.present_change'].execute({})
  })
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click(); await expect(page.getByText('v4')).toBeVisible()
})

test('tablet activity rail opens and closes without covering its control', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'tablet', 'Tablet-only off-canvas behavior.')
  await page.goto(''); await page.getByLabel('Show activity').click(); await expect(page.getByLabel('Hide activity')).toBeVisible()
  await page.getByLabel('Hide activity').click(); await expect(page.getByLabel('Show activity')).toBeVisible()
})

test('Codex tool descriptors stream both generated assets into project-bound preview records', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One full upload pass is sufficient.')
  await page.addInitScript(() => {
    const tools: Record<string, unknown> = {}
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: async (tool: { name: string }) => { tools[tool.name] = tool } } })
    Object.defineProperty(window, '__floorTools', { value: tools })
  })
  await page.goto(''); await page.getByRole('tab', { name: '3D PREVIEWS' }).click()
  await expect(page.getByAltText('Whole-floor axonometric cutaway preview')).toBeVisible()
  const roomSrc = await page.getByAltText('Living-room perspective preview').getAttribute('data-bundled-source')
  const floorSrc = await page.getByAltText('Whole-floor axonometric cutaway preview').getAttribute('data-bundled-source')
  const result = await page.evaluate(async ({ roomSrc, floorSrc }) => {
    type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
    const tools = (window as unknown as { __floorTools: Record<string, Tool> }).__floorTools
    const inputs = [
      { kind: 'room', roomId: 'room_living', source: roomSrc },
      { kind: 'floor', source: floorSrc },
    ]
    const outputs = []
    for (const input of inputs) {
      if (!input.source) throw new Error('Generated preview URL is missing.')
      const bytes = new Uint8Array(await (await fetch(input.source)).arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      const prepared = await tools['floor.prepare_preview'].execute(input.kind === 'room' ? { kind: input.kind, roomId: input.roomId } : { kind: input.kind })
      const ticketId = prepared.ticketId as string
      await tools['floor.preview_begin'].execute({ ticketId, mimeType: 'image/png', checksum, expectedBytes: bytes.byteLength })
      let index = 0
      for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
        const chunk = bytes.slice(offset, Math.min(offset + 256 * 1024, bytes.byteLength)); let binary = ''
        for (let cursor = 0; cursor < chunk.length; cursor += 0x8000) binary += String.fromCharCode(...chunk.subarray(cursor, cursor + 0x8000))
        await tools['floor.preview_chunk'].execute({ ticketId, index, base64: btoa(binary) }); index += 1
      }
      outputs.push(await tools['floor.preview_commit'].execute({ ticketId }))
    }
    return outputs
  }, { roomSrc, floorSrc })
  expect(result).toHaveLength(2); expect(result.every((item) => typeof item.previewId === 'string' && typeof item.checksum === 'string')).toBe(true)
})
