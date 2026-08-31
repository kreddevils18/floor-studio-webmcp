import type { DerivedRoom, Floor, PointMm, ValidationIssue } from '../domain/model'

type WasmGeometry = {
  default: () => Promise<unknown>
  derive_rooms: (floorJson: string) => string
  validate_floor: (floorJson: string) => string
  snap_point: (floorJson: string, x: number, y: number, tolerance: number) => string
  hit_test_wall: (floorJson: string, x: number, y: number, tolerance: number) => string
  wall_render_vertices: (floorJson: string) => Float32Array
  room_render_vertices: (floorJson: string) => Float32Array
}

export class GeometryEngine {
  private wasm: WasmGeometry | null = null
  private state: 'loading' | 'ready' | 'unavailable' = 'loading'

  async initialize() {
    try {
      const module = await import('../../wasm/floor-core/pkg/floor_core.js') as unknown as WasmGeometry
      await module.default()
      this.wasm = module
      this.state = 'ready'
    } catch (error) {
      console.error('Floor geometry could not initialize.', error)
      this.state = 'unavailable'
    }
    return this.state
  }

  get status() { return this.state }
  private requireWasm() { if (!this.wasm) throw new Error('Rust geometry engine is unavailable.'); return this.wasm }
  deriveRooms(floor: Floor): DerivedRoom[] { return JSON.parse(this.requireWasm().derive_rooms(JSON.stringify(floor))) }
  validate(floor: Floor): ValidationIssue[] { return JSON.parse(this.requireWasm().validate_floor(JSON.stringify(floor))) }
  snap(floor: Floor, point: PointMm, toleranceMm = 180): PointMm { return JSON.parse(this.requireWasm().snap_point(JSON.stringify(floor), point.x, point.y, toleranceMm)) }
  hitTestWall(floor: Floor, point: PointMm, toleranceMm = 180): string | null { return this.requireWasm().hit_test_wall(JSON.stringify(floor), point.x, point.y, toleranceMm) || null }
  wallVertices(floor: Floor) { return this.requireWasm().wall_render_vertices(JSON.stringify(floor)) }
  roomVertices(floor: Floor) { return this.requireWasm().room_render_vertices(JSON.stringify(floor)) }
}

export const geometry = new GeometryEngine()
