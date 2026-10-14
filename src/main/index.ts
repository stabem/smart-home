import { app, BrowserWindow, ipcMain, nativeImage, screen, Tray, Menu } from 'electron'
import { join } from 'node:path'
import { HomeController } from './home'
import { loadEnvironment } from './store'
import { fitWindowHeight } from './window-fit'

app.setName('smart-home-tray')
loadEnvironment()

let tray: Tray | undefined
let popup: BrowserWindow | undefined

function trayIcon(): Electron.NativeImage {
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const offset = (y * 16 + x) * 4
      const lit = (y >= 3 && y <= 10 && x >= 5 && x <= 10) || (y >= 11 && y <= 13 && x >= 6 && x <= 9)
      if (lit) {
        pixels[offset] = 240
        pixels[offset + 1] = 193
        pixels[offset + 2] = 87
        pixels[offset + 3] = 255
      }
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 })
}

function positionPopup(): void {
  if (!tray || !popup) return
  const bounds = tray.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const [width, height] = popup.getSize()
  const x = Math.max(area.x, Math.min(bounds.x + bounds.width - width, area.x + area.width - width))
  const above = bounds.y - height
  const y = above >= area.y ? above : Math.min(bounds.y + bounds.height, area.y + area.height - height)
  popup.setPosition(Math.round(x), Math.round(y), false)
}

function togglePopup(): void {
  if (!popup) return
  if (popup.isVisible()) popup.hide()
  else {
    positionPopup()
    popup.show()
    popup.focus()
  }
}

app.whenReady().then(() => {
  const home = new HomeController()
  ipcMain.handle('rooms:list', () => home.rooms())
  ipcMain.handle('device:command', (_event, command) => home.command(command))
  ipcMain.handle('setup:status', () => home.status())
  ipcMain.handle('setup:login', (_event, userCode: unknown) => home.beginLogin(userCode))
  ipcMain.handle('setup:reconnect', () => home.reconnectSmartLife())
  ipcMain.handle('setup:discover', () => home.discover())
  ipcMain.handle('setup:save', (_event, acRoomIds: unknown, groups: unknown) => home.save(acRoomIds, groups))
  ipcMain.handle('groups:sync-guard', (_event, enabled: unknown) => home.setSyncGuard(enabled))
  ipcMain.handle('groups:get', () => home.groupSetup())
  ipcMain.handle('groups:save', (_event, groups: unknown) => home.saveLightGroups(groups))
  ipcMain.handle('home:edit', (_event, assignments: unknown, names: unknown, groups: unknown) => home.saveHomeEdits(assignments, names, groups))
  ipcMain.handle('login:get', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.on('window:fit', (event, contentHeight: unknown) => {
    if (!popup || event.sender !== popup.webContents || typeof contentHeight !== 'number') return
    const area = screen.getDisplayMatching(tray?.getBounds() ?? popup.getBounds()).workArea
    const height = fitWindowHeight(contentHeight, area.height)
    if (popup.getSize()[1] !== height) {
      popup.setSize(420, height, false)
      positionPopup()
    }
  })
  ipcMain.handle('login:set', (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid login setting')
    app.setLoginItemSettings({ openAtLogin: enabled })
  })

  popup = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundMaterial: 'acrylic',
    roundedCorners: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  popup.on('blur', () => popup?.hide())
  popup.on('close', (event) => { event.preventDefault(); popup?.hide() })
  if (process.env.ELECTRON_RENDERER_URL) popup.loadURL(process.env.ELECTRON_RENDERER_URL)
  else popup.loadFile(join(__dirname, '../renderer/index.html'))
  if (process.env.SMART_HOME_CAPTURE_WINDOW === '1') popup.webContents.once('did-finish-load', () => {
    positionPopup()
    popup?.show()
    popup?.focus()
  })

  tray = new Tray(trayIcon())
  tray.setToolTip('Casa')
  tray.on('click', togglePopup)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Casa', click: togglePopup },
    { type: 'separator' },
    { label: 'Sair', click: () => { popup?.removeAllListeners('close'); app.quit() } }
  ]))
})

app.on('window-all-closed', () => { /* tray app remains active */ })
