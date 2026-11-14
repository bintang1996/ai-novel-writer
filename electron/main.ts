import { app, BrowserWindow, ipcMain } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mainT } from './i18n'
import {
  claimReleaseVectorSmokeInvocation,
  releaseVectorSmokeWasRequested,
  runReleaseVectorSmoke,
} from './services/release-vector-smoke'
import { configureSingleInstanceRuntime } from './services/single-instance-runtime'
import { installWindowCloseGuard } from './controllers/window-controller'
import { registerStartupController } from './controllers/startup-controller'
import { resolveDefaultUserData, resolveGlobalDataRoots } from './services/app-data-locator'
import { runGlobalDataMigration, activateGlobalData } from './services/global-data-migration'
import { ensureVelaHome } from './utils/config-utils'
import type { StartupBlockedCode, StartupMigrationNotice } from '../src/shared/startup-contract'
import { APP_BRAND } from '../src/shared/brand'

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// Electron 41 在部分 Windows 环境中无法启动受限 GPU 子进程（0xC0000135），
// 随后会触发 Chromium 的致命检查。仅放宽 GPU 子进程，保持 renderer 隔离策略不变。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null
let startupGeneration: string | null = null
let startupBlockedCode: StartupBlockedCode | undefined
let startupHasSettled = false
let ownsInstanceLock = false
let startupMigrationNotice: StartupMigrationNotice | undefined

// Qualification already supplies this Chromium profile flag. Keep the same profile
// in Electron's locator too; ordinary launches retain their existing userData path.
const explicitUserData = app.commandLine.getSwitchValue('user-data-dir')
if (explicitUserData) {
  if (!path.isAbsolute(explicitUserData)) throw new Error('USER_DATA_PATH_MUST_BE_ABSOLUTE')
  app.setPath('userData', explicitUserData)
} else {
  // 必须早于下面的单实例锁：锁按 userData 路径区分，新旧版本要锁同一处才会互斥。
  app.setPath('userData', resolveDefaultUserData(app.getPath('appData')))
}

// The installed-package vector qualification is deliberately opt-in and
// fail-closed. A command-line request without the matching environment token
// must never turn into a normal interactive application launch.
const releaseVectorSmokeRequested = releaseVectorSmokeWasRequested(process.argv)
const releaseVectorSmokeInvocation = releaseVectorSmokeRequested
  ? claimReleaseVectorSmokeInvocation(process.argv, process.env)
  : undefined
const releaseSmokeRequested = releaseVectorSmokeRequested
const applicationInstanceAccepted = configureSingleInstanceRuntime({
  releaseSmokeRequested,
  requestLock: () => { ownsInstanceLock = app.requestSingleInstanceLock(); return ownsInstanceLock },
  quit: () => app.quit(),
  onSecondInstance: listener => { app.on('second-instance', () => listener()) },
  getWindow: () => win,
})
let releaseSmokeStage = 'not-requested'
let releaseSmokeTimeout: NodeJS.Timeout | undefined

function reportReleaseSmokeStage(stage: string): void {
  if (!releaseSmokeRequested) return
  releaseSmokeStage = stage
  process.stderr.write(`[AI Novel release smoke] stage=${stage}\n`)
}

function clearReleaseSmokeTimeout(): void {
  if (releaseSmokeTimeout === undefined) return
  clearTimeout(releaseSmokeTimeout)
  releaseSmokeTimeout = undefined
}

if (releaseSmokeRequested) {
  reportReleaseSmokeStage('bootstrap')
  const timeoutDescription = 'Packaged vector smoke timed out after 90 seconds'
  releaseSmokeTimeout = setTimeout(() => {
    console.error(`[AI Novel release smoke] ${timeoutDescription}; last stage=${releaseSmokeStage}`)
    app.exit(1)
  }, 90_000)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: startupBlockedCode ? APP_BRAND.enName : mainT(app.getLocale(), 'app.windowTitle'),
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // 使用应用内自绘标题栏，避免 Windows 原生标题栏与棕色标题栏重复显示。
    frame: Boolean(startupBlockedCode),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  // A diagnostic-only window has no editor and no business close responder.
  if (!startupBlockedCode) installWindowCloseGuard(win)

  // 打包后的 Dock 图标来自 icon.icns（按 macOS 网格留了边）；icon.png 是满版的，只在开发时顶上。
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)


  // 所有新窗口都留在应用外；渲染进程不能把现有主窗口导航到外部内容。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' as const }))
  win.webContents.on('will-navigate', event => event.preventDefault())

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  if (!applicationInstanceAccepted) return
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (!applicationInstanceAccepted || releaseSmokeRequested || !startupHasSettled) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  if (!applicationInstanceAccepted) return
  reportReleaseSmokeStage('electron-ready')
  if (releaseSmokeRequested) {
    if (!releaseVectorSmokeInvocation) {
      throw new Error('Invalid packaged smoke invocation: the environment and one-time CLI token pair must match')
    }
    if (!explicitUserData || !process.env.AI_NOVEL_APP_DATA_HOME
      || !(process.env.AI_NOVEL_LEGACY_SOURCE_HOME || process.env.AI_NOVEL_VELA_HOME)) {
      throw new Error('GLOBAL_SMOKE_ISOLATION_REQUIRED')
    }
    // The profile is isolated, but competing writers to that profile still require exclusion.
    ownsInstanceLock = app.requestSingleInstanceLock()
    if (!prepareGlobalRuntime()) throw new Error('GLOBAL_SMOKE_STARTUP_BLOCKED')
    reportReleaseSmokeStage('vector-invocation-valid')
    const evidence = await runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)
    reportReleaseSmokeStage('evidence-ready')
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    clearReleaseSmokeTimeout()
    app.exit(0)
    return
  }

  registerStartupController({
    ipc: ipcMain,
    getTrustedSender: () => win?.webContents ?? null,
    rendererUrl: VITE_DEV_SERVER_URL || pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href,
    getGlobalGeneration: () => startupGeneration,
    getBlockedCode: () => startupBlockedCode,
    getMigrationNotice: () => startupMigrationNotice,
  })
  // No ordinary renderer, default config writer, or business controller precedes this gate.
  if (!prepareGlobalRuntime()) {
    startupHasSettled = true
    createWindow()
    return
  }
  registerIPCHandlers()
  registerMCPHandlers()
  startupHasSettled = true
  createWindow()
}).catch((error: unknown) => {
  clearReleaseSmokeTimeout()
  console.error('[AI Novel Writer] Electron 启动失败，现有配置已保留。')
  if (releaseSmokeRequested) {
    // Controlled qualification errors have safe fixed codes; never print config values.
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) console.error(error.message)
    app.exit(1)
    return
  }
  startupBlockedCode = 'GLOBAL_DATA_BLOCKED'
  startupHasSettled = true
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function prepareGlobalRuntime(): boolean {
  const migrated = runGlobalDataMigration({
    ...resolveGlobalDataRoots(app.getPath('userData'), () => app.getPath('appData')),
    exclusiveAccess: ownsInstanceLock,
  })
  if (migrated.state !== 'ready') {
    startupBlockedCode = migrated.code === 'GLOBAL_MODEL_CREDENTIALS_DIFFER' ? migrated.code : 'GLOBAL_DATA_BLOCKED'
    return false
  }
  activateGlobalData(migrated)
  ensureVelaHome()
  startupGeneration = migrated.globalGeneration
  startupMigrationNotice = { legacySourceIgnored: migrated.legacySourceIgnored, preservedUnknownCount: migrated.preservedUnknownCount }
  startupBlockedCode = undefined
  return true
}
