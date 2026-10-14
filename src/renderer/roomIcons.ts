export type RoomIcon = 'sofa' | 'cutlery' | 'table' | 'bed' | 'laptop' | 'bath' | 'closet' | 'washer' | 'door' | 'lamp'

export function roomIcon(name: string): RoomIcon {
  const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  if (key.includes('sala de estar')) return 'sofa'
  if (key.includes('cozinha')) return 'cutlery'
  if (key.includes('mesa de jantar')) return 'table'
  if (key.includes('quarto')) return 'bed'
  if (key.includes('office') || key.includes('escritorio')) return 'laptop'
  if (key.includes('banheiro')) return 'bath'
  if (key.includes('closet')) return 'closet'
  if (key.includes('lavanderia')) return 'washer'
  if (key.includes('entrada')) return 'door'
  return 'lamp'
}
