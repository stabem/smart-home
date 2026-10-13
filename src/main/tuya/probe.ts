import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { connect, type Socket } from 'node:net'
import { isLanIp } from './protocol'

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>

export function localSubnets(interfaces: Interfaces = networkInterfaces()): string[] {
  const addresses = Object.values(interfaces).flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && isLanIp(entry.address))
    .map(entry => entry.address)
  const preferred = addresses.some(ip => ip.startsWith('192.168.'))
    ? addresses.filter(ip => !ip.startsWith('172.')) : addresses
  return [...new Set(preferred.map(ip => ip.split('.').slice(0, 3).join('.')))].slice(0, 4)
}

export async function probeTcp(
  subnets = localSubnets(),
  socketFactory: (ip: string) => Socket = ip => connect({ host: ip, port: 6668 }),
  timeoutMs = 200,
  deadline = Number.POSITIVE_INFINITY
): Promise<string[]> {
  const targets = subnets.flatMap(prefix => Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`))
  const found: string[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(24, targets.length) }, async () => {
    while (next < targets.length && Date.now() < deadline) {
      const ip = targets[next++]
      const open = await new Promise<boolean>(resolve => {
        let settled = false
        let socket: Socket
        try { socket = socketFactory(ip) } catch { resolve(false); return }
        const finish = (value: boolean): void => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve(value)
        }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        socket.setTimeout(Math.min(timeoutMs, Math.max(1, deadline - Date.now())), () => finish(false))
      })
      if (open) found.push(ip)
    }
  }))
  return found
}
