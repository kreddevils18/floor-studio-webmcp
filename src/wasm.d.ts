declare module '../../wasm/floor-core/pkg/floor_core.js' {
  export default function init(): Promise<unknown>
  export function derive_rooms(floorJson: string): string
  export function validate_floor(floorJson: string): string
  export function snap_point(floorJson: string, x: number, y: number, tolerance: number): string
  export function hit_test_wall(floorJson: string, x: number, y: number, tolerance: number): string
  export function wall_render_vertices(floorJson: string): Float32Array
  export function room_render_vertices(floorJson: string): Float32Array
}
