import type { Light, LightGroup, LightState, Room } from '../shared/types'

export function suggestLightGroups(rooms: Room[]): LightGroup[] {
  return rooms.flatMap(room => {
    const byBase = new Map<string, Light[]>()
    for (const light of room.lights) {
      if (light.switchOnly) continue
      const match = /^(.*?)_(\d+)$/.exec(light.name.trim())
      if (!match) continue
      const base = match[1].trim()
      if (!base) continue
      byBase.set(base, [...(byBase.get(base) ?? []), light])
    }
    return [...byBase].filter(([, lights]) => lights.length > 1).map(([base, lights]) => ({
      id: `group:${room.id}:${base}`, roomId: room.id,
      name: base.toLocaleLowerCase() === room.name.toLocaleLowerCase() ? `Trilho do ${room.name}` : `${base} (trilho)`,
      memberIds: lights.map(light => light.id)
    }))
  })
}

export function validateLightGroups(value: unknown, rooms: Room[]): LightGroup[] {
  if (!Array.isArray(value)) throw new Error('Invalid light groups')
  const used = new Set<string>()
  const ids = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid light group')
    const group = item as LightGroup
    const room = rooms.find(candidate => candidate.id === group.roomId)
    if (!room || typeof group.id !== 'string' || !group.id.startsWith('group:') || ids.has(group.id) ||
      typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 ||
      !Array.isArray(group.memberIds) || group.memberIds.length < 2) throw new Error('Invalid light group')
    ids.add(group.id)
    for (const id of group.memberIds) {
      if (typeof id !== 'string' || used.has(id) || !room.lights.some(light => light.id === id && !light.switchOnly)) throw new Error('Invalid light group member')
      used.add(id)
    }
    return { id: group.id, roomId: group.roomId, name: group.name.trim(), memberIds: [...group.memberIds] }
  })
}

export function applyLightGroups(rooms: Room[], groups: LightGroup[], failures: Record<string, string[]> = {}): Room[] {
  for (const room of rooms) {
    const selected = groups.filter(group => group.roomId === room.id)
    for (const group of selected) {
      const members = group.memberIds.map(id => room.lights.find(light => light.id === id)).filter((light): light is Light => !!light)
      if (members.length !== group.memberIds.length) continue
      const first = members.find(light => light.state.online)
      const state: LightState = { ...(first?.state ?? members[0].state), on: members.some(light => light.state.on), online: members.some(light => light.state.online), viaCloud: members.some(light => light.state.viaCloud) }
      const firstIndex = room.lights.slice(0, room.lights.findIndex(light => light.id === members[0].id)).filter(light => !group.memberIds.includes(light.id)).length
      room.lights = room.lights.filter(light => !group.memberIds.includes(light.id))
      room.lights.splice(firstIndex, 0, { id: group.id, name: group.name, memberIds: group.memberIds, partialFailure: failures[group.id], state })
    }
  }
  return rooms
}
