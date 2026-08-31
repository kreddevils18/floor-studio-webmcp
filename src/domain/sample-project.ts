import type { FurnitureSymbol, Opening, ProjectDocumentV1, RoomMarker, RoomStyle, Wall } from './model'

const wall = (id: string, x1: number, y1: number, x2: number, y2: number, thicknessMm = 160): Wall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thicknessMm,
})

const marker = (id: string, name: string, x: number, y: number): RoomMarker => ({ id, name, position: { x, y } })
const furniture = (
  id: string,
  kind: string,
  label: string,
  x: number,
  y: number,
  widthMm: number,
  depthMm: number,
  rotationDegrees = 0,
): FurnitureSymbol => ({ id, kind, label, position: { x, y }, widthMm, depthMm, rotationDegrees })

const walls: Wall[] = [
  wall('plan_north', 0, 0, 12000, 0, 240),
  wall('plan_east', 12000, 0, 12000, 7500, 240),
  wall('plan_south', 12000, 7500, 0, 7500, 240),
  wall('plan_west', 0, 7500, 0, 0, 180),
  wall('plan_balcony_divider', 2100, 0, 2100, 7500, 220),
  wall('plan_bath_left', 7600, 0, 7600, 2600, 220),
  wall('plan_bath_right', 9400, 0, 9400, 2600, 220),
  wall('plan_bath_bottom', 7600, 2600, 9400, 2600, 220),
  wall('plan_bed_left', 8000, 4300, 8000, 7500, 220),
  wall('plan_bed_top', 8000, 4300, 12000, 4300, 220),
]

const openings: Opening[] = [
  {
    id: 'plan_slide_balcony',
    wallId: 'plan_balcony_divider',
    kind: 'door',
    offsetMm: 2550,
    widthMm: 2300,
    swing: 'sliding',
  },
  { id: 'plan_bath_door', wallId: 'plan_bath_bottom', kind: 'door', offsetMm: 650, widthMm: 820, swing: 'right' },
  { id: 'plan_bed_door', wallId: 'plan_bed_top', kind: 'door', offsetMm: 450, widthMm: 920, swing: 'left' },
  { id: 'plan_entry', wallId: 'plan_east', kind: 'door', offsetMm: 3100, widthMm: 1050, swing: 'right' },
  { id: 'plan_kitchen_window', wallId: 'plan_north', kind: 'window', offsetMm: 2650, widthMm: 2100 },
  { id: 'plan_bath_window', wallId: 'plan_north', kind: 'window', offsetMm: 8000, widthMm: 900 },
  { id: 'plan_bed_window', wallId: 'plan_south', kind: 'window', offsetMm: 700, widthMm: 1750 },
  { id: 'plan_living_window', wallId: 'plan_south', kind: 'window', offsetMm: 4650, widthMm: 2300 },
]

const roomMarkers = [
  marker('room_utility', 'BALCONY', 1050, 3900),
  marker('room_living', 'LIVING ROOM AND KITCHEN', 4800, 3600),
  marker('room_kitchen', 'KITCHEN', 5600, 1150),
  marker('room_bath', 'BATHROOM', 8500, 1400),
  marker('room_hall', 'HALLWAY', 10400, 3400),
  marker('room_bed_1', 'BEDROOM', 10100, 5600),
  marker('room_bed_2', 'DINING', 3900, 1450),
]

const roomStyles: RoomStyle[] = roomMarkers.map((room) => ({
  roomId: room.id,
  floorMaterial: room.id === 'room_bath' ? 'small-format limestone tile' : 'pale smoked oak',
  wallFinish: 'warm mineral white plaster',
  ceilingHeightMm: 2800,
  palette: ['#e7e3da', '#a7a18f', '#46514a', '#b26b3f'],
  renderStyle: 'quiet editorial realism',
}))

export const createSampleProject = (): ProjectDocumentV1 => {
  const timestamp = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: 'project_courtyard_house',
    name: 'Courtyard House',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 3,
    floor: {
      id: 'floor_ground',
      name: 'Ground floor',
      unit: 'mm',
      walls,
      openings,
      roomMarkers,
      furniture: [
        furniture('plan_dining', 'dining-table', 'Six-seat dining table', 3900, 1350, 1850, 900, 90),
        furniture('plan_sofa', 'sofa', 'Three-seat sofa', 5200, 6500, 2500, 900),
        furniture('plan_armchair', 'armchair', 'Lounge chair', 3300, 5400, 850, 850),
        furniture('plan_coffee', 'coffee-table', 'Round coffee tables', 4550, 5300, 1150, 750),
        furniture('plan_island', 'kitchen-island', 'Kitchen island', 6250, 950, 1500, 720),
        furniture('plan_bed', 'bed', 'Queen bed', 10100, 5900, 1850, 2150),
        furniture('plan_vanity', 'vanity', 'Bathroom vanity', 7900, 1650, 650, 500, 90),
        furniture('plan_tub', 'bath', 'Bath', 8500, 550, 1500, 720),
        furniture('plan_balcony_table', 'round-table', 'Balcony table', 950, 6250, 800, 800),
        furniture('plan_plant', 'plant', 'Indoor plant', 1250, 650, 650, 650),
      ],
      dimensions: [
        { id: 'd_width', start: { x: 0, y: -880 }, end: { x: 12000, y: -880 }, label: '12.00 m' },
        { id: 'd_height', start: { x: -880, y: 0 }, end: { x: -880, y: 7500 }, label: '7.50 m' },
      ],
      annotations: [],
      roomStyles,
    },
  }
}
