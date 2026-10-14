// Owner-editable discovery defaults. Match names, never device IDs or secrets.
export const houseRooms = ['Sala de estar', 'Mesa de jantar', 'Office', 'Quarto', 'Lavanderia', 'Banheiro suíte'] as const

const roomAliases: Record<string, string> = {
  'lavandeira': 'Lavanderia',
  'banheiro suite': 'Banheiro suíte'
}

export function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim()
}

export function roomName(value: string): string {
  const trimmed = value.trim()
  return roomAliases[normalized(trimmed)] ?? houseRooms.find(room => normalized(room) === normalized(trimmed)) ?? trimmed
}

export function matchingRoom(deviceName: string, availableRooms: readonly string[] = houseRooms): string | undefined {
  const words = normalized(deviceName)
  return availableRooms.find(room => {
    const name = normalized(room).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(words)
  })
    ?? (/(^|[^a-z])sala([^a-z]|$)/.test(words) ? 'Sala de estar' : undefined)
}

export function gangDefault(deviceName: string, dp: number): { name: string; room?: string } | undefined {
  switch (normalized(deviceName)) {
    case 'sala de estar': return ({
      1: { name: 'LED teto' },
      2: { name: 'LED sala de jantar', room: 'Mesa de jantar' },
      3: { name: 'Lustre' },
      4: { name: 'Cortineiro da sala' }
    } as Record<number, { name: string; room?: string }>)[dp]
    case 'office': return ({
      1: { name: 'Cortineiro do Office' },
      2: { name: 'Cortineiro do Quarto', room: 'Quarto' }
    } as Record<number, { name: string; room?: string }>)[dp]
    default: return undefined
  }
}
