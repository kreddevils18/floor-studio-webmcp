import type { Floor } from '../domain/model'
import { geometry } from '../core/geometry-engine'

export interface Camera { zoom: number; offsetX: number; offsetY: number }

const shader = `
struct VertexOut { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vertexMain(@location(0) position: vec2f, @location(1) color: vec4f) -> VertexOut {
  var output: VertexOut; output.position = vec4f(position, 0.0, 1.0); output.color = color; return output;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4f { return input.color; }
`

function addTriangle(vertices: number[], points: Array<[number, number]>, color: [number, number, number, number]) {
  for (const point of points) vertices.push(point[0], point[1], ...color)
}

function addLine(vertices: number[], start: [number, number], end: [number, number], width: number, color: [number, number, number, number]) {
  const dx = end[0] - start[0]; const dy = end[1] - start[1]; const length = Math.hypot(dx, dy) || 1
  const nx = -dy / length * width / 2; const ny = dx / length * width / 2
  const a: [number, number] = [start[0] + nx, start[1] + ny]; const b: [number, number] = [end[0] + nx, end[1] + ny]
  const c: [number, number] = [end[0] - nx, end[1] - ny]; const d: [number, number] = [start[0] - nx, start[1] - ny]
  addTriangle(vertices, [a, b, c, a, c, d], color)
}

export class WebGpuPlanRenderer {
  private device: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private pipeline: GPURenderPipeline | null = null
  status: 'loading' | 'ready' | 'unsupported' = 'loading'

  async initialize(canvas: HTMLCanvasElement, onUnavailable?: () => void) {
    if (!navigator.gpu) { this.status = 'unsupported'; return this.status }
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) throw new Error('No WebGPU adapter is available.')
      this.device = await adapter.requestDevice(); this.context = canvas.getContext('webgpu')
      if (!this.context) throw new Error('Canvas WebGPU context is unavailable.')
      this.device.lost.then(() => { this.status = 'unsupported'; this.device = null; this.pipeline = null; onUnavailable?.() }).catch(() => undefined)
      const format = navigator.gpu.getPreferredCanvasFormat()
      this.context.configure({ device: this.device, format, alphaMode: 'premultiplied' })
      const module = this.device.createShaderModule({ code: shader })
      this.pipeline = this.device.createRenderPipeline({
        layout: 'auto', vertex: { module, entryPoint: 'vertexMain', buffers: [{ arrayStride: 24, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x4' },
        ] }] }, fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-list' },
      })
      this.status = 'ready'; return this.status
    } catch (error) {
      console.warn('WebGPU initialization failed; using the SVG review layer.', error)
      this.status = 'unsupported'; onUnavailable?.(); return this.status
    }
  }

  render(canvas: HTMLCanvasElement, floor: Floor, camera: Camera, selectedIds: string[], proposed: boolean) {
    if (!this.device || !this.context || !this.pipeline) return
    const dpr = Math.min(devicePixelRatio, 2); const width = Math.max(1, canvas.clientWidth); const height = Math.max(1, canvas.clientHeight)
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) { canvas.width = width * dpr; canvas.height = height * dpr }
    const toClip = (x: number, y: number): [number, number] => [((camera.offsetX + x * camera.zoom) / width) * 2 - 1, 1 - ((camera.offsetY + y * camera.zoom) / height) * 2]
    const vertices: number[] = []
    for (let x = -2000; x <= 14000; x += 500) addLine(vertices, toClip(x, -1600), toClip(x, 9200), 0.0012, [0.76, 0.77, 0.74, x % 1000 === 0 ? 0.32 : 0.16])
    for (let y = -1500; y <= 9000; y += 500) addLine(vertices, toClip(-2200, y), toClip(14000, y), 0.0012, [0.76, 0.77, 0.74, y % 1000 === 0 ? 0.32 : 0.16])
    const roomVertices = geometry.roomVertices(floor)
    for (let index = 0; index < roomVertices.length; index += 6) addTriangle(vertices, [toClip(roomVertices[index], roomVertices[index + 1]), toClip(roomVertices[index + 2], roomVertices[index + 3]), toClip(roomVertices[index + 4], roomVertices[index + 5])], [0.92, 0.91, 0.86, 0.9])
    const walls = geometry.wallVertices(floor)
    for (let index = 0; index < walls.length; index += 12) {
      const color: [number, number, number, number] = proposed ? [0.06, 0.26, 0.92, 1] : [0.10, 0.105, 0.095, 1]
      for (let vertex = 0; vertex < 6; vertex += 1) vertices.push(...toClip(walls[index + vertex * 2], walls[index + vertex * 2 + 1]), ...color)
    }
    for (const wall of floor.walls.filter((entry) => selectedIds.includes(entry.id))) addLine(vertices, toClip(wall.start.x, wall.start.y), toClip(wall.end.x, wall.end.y), Math.max(0.004, wall.thicknessMm * camera.zoom / width * 2 + 0.003), [0.02, 0.34, 0.96, 1])
    const data = new Float32Array(vertices); const buffer = this.device.createBuffer({ size: Math.max(4, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    if (data.byteLength) this.device.queue.writeBuffer(buffer, 0, data)
    const encoder = this.device.createCommandEncoder(); const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0.965, g: 0.962, b: 0.95, a: 1 }, loadOp: 'clear', storeOp: 'store' }] })
    pass.setPipeline(this.pipeline); pass.setVertexBuffer(0, buffer); pass.draw(data.length / 6); pass.end(); this.device.queue.submit([encoder.finish()])
    void this.device.queue.onSubmittedWorkDone().then(() => buffer.destroy())
  }
}
