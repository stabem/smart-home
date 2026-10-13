import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { decodeBroadcast, isLanIp, packFrame, udpKey, type TuyaVersion } from './protocol'
import { localSubnets } from './probe'

export interface LanAddress { id: string; ip: string; version?: TuyaVersion }

function closeSocket(socket: UdpSocket): void {
  try { socket.close() } catch { /* Already closed after a UDP error. */ }
}

export async function discoverLan(
  durationMs = 6000,
  socketFactory: () => UdpSocket = () => createSocket({ type: 'udp4', reuseAddr: true }),
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()
): Promise<Map<string, LanAddress>> {
  const found = new Map<string, LanAddress>()
  const ports = [6666, 6667, 7000]
  const sockets = ports.map(() => socketFactory())
  let packets = 0
  const bound = await Promise.all(sockets.map((socket, index) => new Promise<boolean>(resolve => {
    let bound = false
    socket.on('message', (packet, source) => {
      packets++
      const device = decodeBroadcast(packet)
      if (device && isLanIp(source.address)) found.set(device.id, { ...device, ip: source.address })
    })
    socket.on('error', error => {
      if (!bound) {
        if ((error as NodeJS.ErrnoException).code === 'EACCES') console.warn(`Tuya discovery: UDP ${ports[index]} blocked; allow inbound UDP 6666, 6667 and 7000 for this app in Windows Firewall`)
        resolve(false)
      }
      else closeSocket(socket)
    })
    socket.bind(ports[index], '0.0.0.0', () => {
      bound = true
      resolve(true)
    })
  })))
  if (bound[2]) {
    const preferred = new Set(localSubnets(interfaces))
    const entries = Object.values(interfaces).flatMap(values => values ?? [])
      .filter(entry => entry.family === 'IPv4' && !entry.internal && isLanIp(entry.address)
        && preferred.has(entry.address.split('.').slice(0, 3).join('.')))
      .slice(0, 4)
    try { sockets[2].setBroadcast(true) } catch { /* UDP binding can succeed without broadcast permission. */ }
    for (const entry of entries) {
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4 || mask.some(value => !Number.isInteger(value))) continue
      const broadcast = ip.map((value, index) => (value | (255 ^ mask[index])) & 255).join('.')
      const packet = packFrame('3.5', udpKey, 1, 0x25, Buffer.from(JSON.stringify({ from: 'app', ip: entry.address })))
      try { sockets[2].send(packet, 7000, broadcast, () => {}) } catch { /* Continue listening for announcements. */ }
    }
  }
  await new Promise(resolve => setTimeout(resolve, durationMs))
  sockets.forEach(closeSocket)
  if (!packets && bound.some(Boolean)) console.warn('Tuya discovery: no UDP announcements on 6666/6667/7000; check Windows Firewall inbound UDP rules for this app')
  return found
}
