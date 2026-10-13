export interface PlanArea {
  label: string
  room: string | null
  x: number
  y: number
  w: number
  h: number
}

// Metres from docs/DESIGN.md, with the drawing origin at its top left.
export const floorplan: PlanArea[] = [
  { label: 'Entrada', room: 'entrada', x: 0, y: 4.7, w: 1.2, h: 1.5 },
  { label: 'Cozinha', room: 'cozinha', x: 1.2, y: 3.1, w: 3.8, h: 3 },
  { label: 'Sala de jantar', room: 'mesa-de-jantar', x: 0, y: 6.1, w: 6.5, h: 3.1 },
  { label: 'Sala de estar', room: 'sala-de-estar', x: 0, y: 9.3, w: 3.2, h: 3.9 },
  { label: 'Home office', room: 'office', x: 3.3, y: 9.3, w: 3.2, h: 3.9 },
  { label: 'Banho social', room: 'banheiro', x: 4.9, y: 4.9, w: 1.6, h: 3.2 },
  { label: 'Closet', room: null, x: 6.5, y: 4.9, w: 3.2, h: 3.2 },
  { label: 'Suíte', room: 'quarto', x: 6.6, y: 8.6, w: 3.1, h: 4.6 },
  { label: 'Banho suíte', room: 'banheiro-da-suite', x: 5.1, y: 13.3, w: 2.8, h: 2 },
  { label: 'Área de serviço', room: null, x: 5, y: 1.7, w: 1.6, h: 3.1 },
  { label: 'Pets', room: null, x: 3.9, y: 0, w: 2.6, h: 1.7 },
  { label: 'Varanda estar', room: null, x: 0, y: 13.3, w: 5, h: 0.7 },
  { label: 'Varanda suíte', room: null, x: 7.9, y: 13.3, w: 1.7, h: 0.7 }
]

export function roomSlug(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
