import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { DeviceCommand, Room, SetupStatus, SmartHomeApi } from '../shared/types'

export function App({ api }: { api: SmartHomeApi }) {
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [discovered, setDiscovered] = useState<Room[] | null>(null)
  const [qrImage, setQrImage] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [login, setLogin] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [userCode, setUserCode] = useState('')
  const [acRoomIds, setAcRoomIds] = useState<Record<string, string>>({})

  async function refresh() { setRooms(await api.getRooms()) }
  useEffect(() => {
    void api.getSetupStatus().then(setSetup).catch(() => setError('Não foi possível abrir a configuração salva.'))
    void api.getRooms().then(setRooms).catch(() => setRooms([]))
    void api.getLaunchAtLogin().then(setLogin)
  }, [api])

  async function beginLogin() {
    try {
      setError('')
      const uri = await api.beginSmartLifeLogin(userCode)
      setQrImage(await QRCode.toDataURL(uri, { width: 192, margin: 2 }))
    } catch { setError('Não foi possível gerar o QR. Confira USER_CODE_SMARTLIFE e a conexão.') }
  }

  async function search() {
    setBusy(true)
    setError('')
    try {
      const found = await api.discoverDevices()
      setDiscovered(found)
      setAcRoomIds(Object.fromEntries(found.flatMap(room => room.acs.map(ac => [ac.id, room.id]))))
    }
    catch { setError('Busca falhou ou o QR ainda não foi lido. Tente novamente.') }
    finally { setBusy(false) }
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      await api.saveSetup(acRoomIds)
      setSetup(await api.getSetupStatus())
      await refresh()
    } catch { setError('Não foi possível salvar a configuração com proteção do sistema.') }
    finally { setBusy(false) }
  }

  async function command(value: DeviceCommand) {
    try { setError(''); await api.sendCommand(value); await refresh() }
    catch { setError('Não foi possível atualizar o dispositivo.') }
  }

  if (rooms === null || setup === null) return <main><p role="status">Carregando...</p>{error && <p role="alert">{error}</p>}</main>
  if (!setup.configured) return <main>
    <header><h1>Configurar</h1></header>
    <section className="card"><p role="status" aria-label="Token LG">Token LG: {setup.lgTokenConfigured ? 'pronto' : 'não configurado'}</p><p role="status" aria-label="Chaves Tuya">Chaves Tuya: {setup.tuyaKeysConfigured ? 'salvas' : 'não configuradas'}</p></section>
    <section className="card setupFlow">
      <label>Smart Life User Code <input aria-label="Smart Life User Code" type="text" autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} placeholder={setup.smartLifeUserCodeConfigured ? 'Configurado no .env (opcional)' : 'Digite seu User Code'} /></label>
      <p>Escaneie o QR com o app Smart Life.</p>
      <button onClick={() => void beginLogin()}>Gerar QR Smart Life</button>
      {qrImage && <img className="qr" src={qrImage} alt="QR Smart Life" />}
      <button disabled={busy} onClick={() => void search()}>Buscar dispositivos</button>
    </section>
    {discovered && <section className="card"><h2>Dispositivos encontrados</h2><ul aria-label="Dispositivos encontrados">{discovered.map(room => <li key={room.id}><strong>{room.name}</strong><ul>{room.lights.map(light => <li key={light.id}>{light.name}</li>)}{room.acs.map(ac => <li key={ac.id}><label>{ac.name} — Cômodo <select aria-label={`Cômodo de ${ac.name}`} value={acRoomIds[ac.id] || room.id} onChange={event => setAcRoomIds(current => ({ ...current, [ac.id]: event.target.value }))}>{discovered.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></li>)}</ul></li>)}</ul><button disabled={busy || !discovered.length} onClick={() => void save()}>Salvar</button></section>}
    {error && <p role="alert">{error}</p>}
  </main>

  const room = rooms.find((item) => item.id === selected)
  if (room) return <main>
    <header className="roomHeader"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}>Voltar</button><h1>{room.name}</h1></header>
    {room.lights.map((light) => <section className="card" key={light.id}>
      <div className="cardHead"><strong>{light.name}</strong><button role="switch" aria-label={light.name} aria-checked={light.state.online && light.state.on} disabled={!light.state.online} onClick={() => void command({ kind: 'light.power', deviceId: light.id, on: !light.state.on })}>{!light.state.online ? 'Offline' : light.state.on ? 'Ligada' : 'Desligada'}</button></div>
      <label>Brilho <input type="range" aria-label="Brilho" min="1" max="100" disabled={!light.state.online} value={light.state.brightness ?? 100} onChange={(event) => void command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(event.target.value) })} /></label>
      <button disabled={!light.state.online} aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor</button>
      {colorFor === light.id && <div className="appearance">
        {light.state.color !== undefined && <>
          <label>Cor <input type="color" aria-label="Escolher cor" value={light.state.color} onChange={(event) => void command({ kind: 'light.color', deviceId: light.id, color: event.target.value })} /></label>
          <span role="status" aria-label="Cor atual">{light.state.color}</span>
        </>}
        {light.state.temperature !== undefined && <label>Temperatura da luz
          <input type="range" aria-label="Temperatura da luz" min="0" max="100" value={light.state.temperature} onChange={(event) => void command({ kind: 'light.temperature', deviceId: light.id, temperature: Number(event.target.value) })} />
        </label>}
        {light.state.color === undefined && light.state.temperature === undefined && <p className="muted" role="status">Controle de cor ainda não disponível para este dispositivo.</p>}
      </div>}
    </section>)}
    {room.acs.map(ac => <section className="card" key={ac.id}>
      <div className="cardHead"><strong>{ac.name}</strong><button aria-label={ac.state.on ? 'Desligar ar' : 'Ligar ar'} onClick={() => void command({ kind: 'ac.power', deviceId: ac.id, on: !ac.state.on })}>{ac.state.on ? 'Ligado' : 'Desligado'}</button></div>
      <p>Ambiente: {ac.state.currentTemperature}°C</p>
      <div className="temperature"><button aria-label="Diminuir" onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.max(16, ac.state.targetTemperature - 1) })}>−</button><strong>{ac.state.targetTemperature}°C</strong><button aria-label="Aumentar" onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.min(30, ac.state.targetTemperature + 1) })}>+</button></div>
      <input type="range" aria-label="Temperatura" min="16" max="30" value={ac.state.targetTemperature} onChange={(event) => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Number(event.target.value) })} />
      <div className="actions"><button disabled title="Controle ainda não disponível">Modo</button><button disabled title="Controle ainda não disponível">Ventilação</button><button role="switch" aria-label="Turbo" aria-checked={ac.state.turbo ?? false} disabled title="Controle ainda não disponível">Turbo</button></div>
      <p className="updated" role="status">{ac.state.online ? `Atualizado${ac.state.updatedAt ? ` ${ac.state.updatedAt}` : ''}` : 'Offline'}</p>
    </section>)}
    {error && <p role="alert">{error}</p>}
  </main>

  return <main>
    <header><div><span className="eyebrow">CONTROLE DA CASA</span><h1>Casa</h1></div><span className="muted">Minha casa</span></header>
    <h2 className="listHeading">Cômodos</h2>
    <ul aria-label="Cômodos" className="rooms">{rooms.map((item) => {
      const online = item.lights.every(light => light.state.online)
      const on = item.lights.length > 0 && online && item.lights.every((light) => light.state.on)
      const contents = !online ? 'Offline' : item.acs.length ? (item.lights.length ? 'Luzes · Ar' : 'Ar') : 'Luzes'
      return <li className="card room" key={item.id}>
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}>{item.name}<span className="muted">{contents}</span></button>
        <button className="roomLights" aria-label={`Luzes ${item.name}`} aria-pressed={on} disabled={!item.lights.length || !online} onClick={() => void Promise.all(item.lights.map((light) => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: !on }))).catch(() => setError('Não foi possível atualizar todas as luzes.')).finally(refresh)}>{on ? '●' : '○'}</button>
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </li>
    })}</ul>
    {error && <p role="alert">{error}</p>}
    <label className="login"><input type="checkbox" checked={login} onChange={(event) => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label>
  </main>
}
