import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { decodeBroadcast, isLanIp, type TuyaVersion } from './protocol'

export interface LanAddress { id: string; ip: string; version?: TuyaVersion }

function closeSocket(socket: UdpSocket): void {
  try { socket.close() } catch { /* Already closed after a UDP error. */ }
}

export async function discoverLan(
  durationMs = 6000,
  socketFactory: () => UdpSocket = () => createSocket({ type: 'udp4', reuseAddr: true })
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
  await new Promise(resolve => setTimeout(resolve, durationMs))
  sockets.forEach(closeSocket)
  if (!packets && bound.some(Boolean)) console.warn('Tuya discovery: no UDP announcements on 6666/6667/7000; check Windows Firewall inbound UDP rules for this app')
  return found
}
