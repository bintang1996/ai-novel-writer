import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  const windows: Array<Record<string, unknown>> = []
  const BrowserWindow = vi.fn(function MockBrowserWindow(this: Record<string, unknown>) {
    calls.push('create-window')
    windows.push(this)
    this.id = windows.length
    this.webContents = {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    this.isDestroyed = () => false
    this.on = vi.fn()
    this.setMenuBarVisibility = vi.fn()
    this.loadURL = vi.fn()
    this.loadFile = vi.fn()
  })
  Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => windows) })

  return {
    calls,
    userData: '',
    appData: '',
    windows,
    BrowserWindow,
    registerIPCHandlers: vi.fn(() => calls.push('ipc')),
    registerMCPHandlers: vi.fn(() => calls.push('mcp')),
    openExternal: vi.fn(async () => undefined),
    app: {
      commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn(() => '') },
      getPath: vi.fn((name: string) => name === 'appData' ? mocks.appData : mocks.userData),
      setPath: vi.fn(),
      getLocale: () => 'zh-CN',
      getVersion: () => '0.7.0',
      isPackaged: false,
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      quit: vi.fn(),
      exit: vi.fn(),
      dock: { setIcon: vi.fn() },
    },
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('../ipc-handlers', () => ({ registerIPCHandlers: mocks.registerIPCHandlers }))
vi.mock('../mcp/mcp-ipc-bridge', () => ({ registerMCPHandlers: mocks.registerMCPHandlers }))
vi.mock('../services/release-vector-smoke', () => ({
  claimReleaseVectorSmokeInvocation: vi.fn(),
  releaseVectorSmokeWasRequested: () => false,
  runReleaseVectorSmoke: vi.fn(),
}))

describe('interactive Electron startup', () => {
  let fixtureRoot: string
  let legacy: string
  let canonical: string
  beforeEach(() => {
    vi.resetModules()
    mocks.calls.splice(0)
    mocks.windows.splice(0)
    mocks.registerIPCHandlers.mockClear()
    mocks.registerMCPHandlers.mockClear()
    mocks.openExternal.mockClear()
    mocks.BrowserWindow.mockClear()
    mocks.app.requestSingleInstanceLock.mockReturnValue(true)
    const fixtureBase = path.resolve('.runtime/.cache/main-startup-tests')
    fs.mkdirSync(fixtureBase, { recursive: true })
    fixtureRoot = fs.mkdtempSync(path.join(fixtureBase, 'run-'))
    legacy = path.join(fixtureRoot, 'legacy'); canonical = path.join(fixtureRoot, 'canonical')
    mocks.userData = path.join(fixtureRoot, 'userData')
    mocks.appData = path.join(fixtureRoot, 'appData')
    fs.mkdirSync(legacy); fs.mkdirSync(mocks.userData)
    fs.writeFileSync(path.join(legacy, 'config.json'), '{}')
    fs.writeFileSync(path.join(mocks.userData, 'retained.json'), 'original Chromium profile')
    vi.stubEnv('AI_NOVEL_LEGACY_SOURCE_HOME', legacy)
    vi.stubEnv('AI_NOVEL_APP_DATA_HOME', canonical)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it('registers service IPC before constructing the renderer window', async () => {
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('create-window'))

    expect(mocks.calls.indexOf('ipc')).toBeLessThan(mocks.calls.indexOf('create-window'))
    expect(mocks.calls.indexOf('mcp')).toBeLessThan(mocks.calls.indexOf('create-window'))
    expect(JSON.parse(fs.readFileSync(path.join(canonical, '.migration/receipt.json'), 'utf8')).completed).toBe(true)
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('{}')
    expect(fs.readFileSync(path.join(mocks.userData, 'retained.json'), 'utf8')).toBe('original Chromium profile')
    expect(mocks.windows[0]?.on).toHaveBeenCalledWith('close', expect.any(Function))
  })

  it('passes Electron appData to migration when no canonical override is configured', async () => {
    vi.stubEnv('AI_NOVEL_APP_DATA_HOME', '')
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('create-window'))
    expect(JSON.parse(fs.readFileSync(path.join(mocks.appData, 'ai-novel-writer/.migration/receipt.json'), 'utf8')).completed).toBe(true)
    expect(fs.existsSync(canonical)).toBe(false)
    expect(fs.readFileSync(path.join(mocks.userData, 'retained.json'), 'utf8')).toBe('original Chromium profile')
  })

  it('starts with the default Chromium profile without changing its existing data', async () => {
    vi.stubEnv('AI_NOVEL_APP_DATA_HOME', '')
    mocks.userData = path.join(mocks.appData, 'ai-novel-writer')
    fs.mkdirSync(mocks.userData, { recursive: true })
    fs.writeFileSync(path.join(mocks.userData, 'retained.json'), 'original Chromium profile')

    await import('../main')
    await vi.waitFor(() => expect(mocks.BrowserWindow).toHaveBeenCalledOnce())

    expect(mocks.registerIPCHandlers).toHaveBeenCalledOnce()
    expect(mocks.registerMCPHandlers).toHaveBeenCalledOnce()
    expect(fs.readdirSync(mocks.userData)).toEqual(['retained.json'])
    expect(fs.readFileSync(path.join(mocks.userData, 'retained.json'), 'utf8')).toBe('original Chromium profile')
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('{}')
  })

  it('shows only a diagnostic window when source JSON is corrupt', async () => {
    fs.writeFileSync(path.join(legacy, 'config.json'), '{corrupt')
    await import('../main')
    await vi.waitFor(() => expect(mocks.BrowserWindow).toHaveBeenCalledOnce())
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(mocks.registerMCPHandlers).not.toHaveBeenCalled()
    expect(fs.existsSync(canonical)).toBe(false)
    expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('{corrupt')
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ frame: true }))
  })

  it.each(['{"version":1,"activeSkin":"anime"}', '{"version":1,"activeSkin":"custom"}', '{broken'])('旧版本留下的皮肤清单 %s 不再读取，不阻断启动，原样带进新数据目录', async manifest => {
    fs.mkdirSync(path.join(legacy, 'skins'))
    fs.writeFileSync(path.join(legacy, 'skins', 'manifest.json'), manifest)
    await import('../main')
    await vi.waitFor(() => expect(mocks.calls).toContain('create-window'))
    expect(mocks.registerIPCHandlers).toHaveBeenCalledOnce()
    const receipt = JSON.parse(fs.readFileSync(path.join(canonical, '.migration/receipt.json'), 'utf8'))
    expect(fs.readFileSync(path.join(canonical, 'generations', receipt.generation, 'skins', 'manifest.json'), 'utf8')).toBe(manifest)
    expect(fs.readFileSync(path.join(legacy, 'skins', 'manifest.json'), 'utf8')).toBe(manifest)
  })

  it('does not migrate or create a window without the existing single-instance lock', async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false)
    await import('../main')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.app.quit).toHaveBeenCalled()
    expect(mocks.BrowserWindow).not.toHaveBeenCalled()
    expect(mocks.registerIPCHandlers).not.toHaveBeenCalled()
    expect(fs.existsSync(canonical)).toBe(false)
  })

})
