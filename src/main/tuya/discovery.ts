import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { decodeBroadcast, type TuyaVersion } from './protocol'

export interface LanAddress { id: string; ip: string; version?: TuyaVersion }

function closeSocket(socket: UdpSocket): void {
  try { socket.close() } catch { /* Already closed after a UDP error. */ }
}

export async function discoverLan(
  durationMs = 1200,
  socketFactory: () => UdpSocket = () => createSocket({ type: 'udp4', reuseAddr: true })
): Promise<Map<string, LanAddress>> {
  const found = new Map<string, LanAddress>()
  const sockets = [6666, 6667].map(() => socketFactory())
  await Promise.all(sockets.map((socket, index) => new Promise<void>((resolve, reject) => {
    let bound = false
    socket.on('message', packet => {
      const device = decodeBroadcast(packet)
      if (device) found.set(device.id, device)
    })
    socket.on('error', error => {
      if (!bound) reject(error)
      else closeSocket(socket)
    })
    socket.bind([6666, 6667][index], '0.0.0.0', () => {
      bound = true
      resolve()
    })
  }))).catch(error => { sockets.forEach(closeSocket); throw error })
  await new Promise(resolve => setTimeout(resolve, durationMs))
  sockets.forEach(closeSocket)
  return found
}
