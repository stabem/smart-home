import { describe, expect, it } from 'vitest'
import { roomIcon } from './roomIcons'

describe('roomIcon', () => {
  it.each([
    ['Sala de estar', 'sofa'], ['Cozinha', 'cutlery'], ['Mesa de jantar', 'table'],
    ['Quarto', 'bed'], ['Office', 'laptop'], ['Banheiro da suíte', 'bath'],
    ['Closet', 'closet'], ['Lavanderia', 'washer'], ['Entrada', 'door'], ['Corredor', 'lamp']
  ] as const)('maps %s to %s', (name, icon) => expect(roomIcon(name)).toBe(icon))
})
