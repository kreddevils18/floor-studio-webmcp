import type { FurnitureSymbol, Opening, ProjectDocumentV1, RoomMarker, RoomStyle, Wall } from './model'

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thicknessMm = 160): Wall => ({
  id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thicknessMm,
})

const marker = (id: string, name: string, x: number, y: number): RoomMarker => ({ id, name, position: { x, y } })
const furniture = (id: string, kind: string, label: string, x: number, y: number, widthMm: number, depthMm: number, rotationDegrees = 0): FurnitureSymbol => ({ id, kind, label, position: { x, y }, widthMm, depthMm, rotationDegrees })

const walls: Wall[] = [
  wall('w_north', 0, 0, 11800, 0, 220), wall('w_east', 11800, 0, 11800, 7600, 220),
  wall('w_south', 11800, 7600, 0, 7600, 220), wall('w_west', 0, 7600, 0, 0, 220),
  wall('w_hall_left', 4300, 0, 4300, 7600), wall('w_hall_right', 6500, 0, 6500, 7600),
  wall('w_left_split', 0, 4100, 4300, 4100), wall('w_left_bath', 2200, 4100, 2200, 7600),
  wall('w_right_split', 6500, 3900, 11800, 3900), wall('w_right_lower', 6500, 5700, 11800, 5700),
]

const openings: Opening[] = [
  { id: 'o_entry', wallId: 'w_south', kind: 'door', offsetMm: 5000, widthMm: 1100, swing: 'right' },
  { id: 'o_bed_1', wallId: 'w_hall_left', kind: 'door', offsetMm: 1550, widthMm: 900, swing: 'left' },
  { id: 'o_bed_2', wallId: 'w_hall_right', kind: 'door', offsetMm: 1450, widthMm: 900, swing: 'right' },
  { id: 'o_living', wallId: 'w_hall_right', kind: 'door', offsetMm: 4700, widthMm: 1050, swing: 'left' },
  { id: 'o_window_living', wallId: 'w_east', kind: 'window', offsetMm: 900, widthMm: 2500 },
  { id: 'o_window_bed', wallId: 'w_west', kind: 'window', offsetMm: 900, widthMm: 1800 },
]

const roomMarkers = [
  marker('room_bed_1', 'BEDROOM 01', 2100, 1900), marker('room_bed_2', 'BEDROOM 02', 9000, 1900),
  marker('room_hall', 'HALL', 5400, 3600), marker('room_bath', 'BATH', 1100, 5900),
  marker('room_utility', 'UTILITY', 3300, 5900), marker('room_living', 'LIVING / DINING', 9000, 4750),
  marker('room_kitchen', 'KITCHEN', 9000, 6650),
]

const roomStyles: RoomStyle[] = roomMarkers.map((room) => ({
  roomId: room.id,
  floorMaterial: room.id === 'room_bath' ? 'small-format limestone tile' : 'pale smoked oak',
  wallFinish: 'warm mineral white plaster', ceilingHeightMm: 2800,
  palette: ['#e7e3da', '#a7a18f', '#46514a', '#b26b3f'], renderStyle: 'quiet editorial realism',
}))

export const createSampleProject = (): ProjectDocumentV1 => {
  const timestamp = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: 'project_courtyard_house', name: 'Courtyard House', createdAt: timestamp, updatedAt: timestamp, revision: 3,
    floor: {
      id: 'floor_ground', name: 'Ground floor', unit: 'mm', walls, openings, roomMarkers,
      furniture: [
        furniture('f_bed_1', 'bed', 'Queen bed', 2100, 1900, 1700, 2100), furniture('f_bed_2', 'bed', 'Queen bed', 9000, 1850, 1700, 2100),
        furniture('f_sofa', 'sofa', 'Three-seat sofa', 7900, 4600, 2400, 950), furniture('f_table', 'table', 'Dining table', 10300, 4700, 1500, 850, 90),
        furniture('f_island', 'island', 'Kitchen island', 9100, 6500, 2200, 900), furniture('f_tub', 'bath', 'Bath', 1100, 5800, 1600, 750, 90),
      ],
      dimensions: [
        { id: 'd_width', start: { x: 0, y: -650 }, end: { x: 11800, y: -650 }, label: '11 800' },
        { id: 'd_height', start: { x: -650, y: 0 }, end: { x: -650, y: 7600 }, label: '7 600' },
      ],
      annotations: [{ id: 'note_1', position: { x: 7000, y: 6200 }, text: 'Review kitchen circulation', kind: 'comment' }],
      roomStyles,
    },
  }
}

