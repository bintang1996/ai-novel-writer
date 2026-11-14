import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string) {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('Electron main window chrome contract', () => {
  it('uses native controls only for diagnostic windows and keeps the writer title bar in the normal workspace', () => {
    const main = source('electron/main.ts')

    expect(main).toMatch(/frame:\s*Boolean\(startupBlockedCode\)/)
    expect(main).not.toMatch(/titleBarStyle:\s*'hiddenInset'/)
  })

  it('uses the narrow Windows GPU-process workaround without weakening the renderer sandbox', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("app.commandLine.appendSwitch('disable-gpu-sandbox')")
    expect(main).not.toContain("appendSwitch('no-sandbox')")
    expect(main).not.toContain("appendSwitch('in-process-gpu')")
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('contextIsolation: true')
  })

  it('registers window control IPC for frameless minimize maximize and close buttons', () => {
    const ipcHandlers = source('electron/ipc-handlers.ts')
    const ipcChannels = source('src/shared/ipc-channels.ts')
    const titleBar = source('src/components/stage/StageTopBar.tsx')

    expect(ipcHandlers).toContain('registerWindowController')
    for (const channel of ['window:minimize', 'window:toggle-maximize', 'window:close']) {
      expect(ipcChannels).toContain(`'${channel}'`)
      expect(titleBar).toContain(`'${channel}'`)
    }
    expect(titleBar).not.toContain('最小化窗口由系统标题栏控制')
  })

  it('denies all renderer popups and prevents renderer navigation', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("setWindowOpenHandler(() => ({ action: 'deny' as const }))")
    expect(main).toContain("on('will-navigate', event => event.preventDefault())")
  })

  it('runs the packaged vector qualification through the real Electron main process without opening a window', () => {
    const main = source('electron/main.ts')

    expect(main).toContain("from './services/release-vector-smoke'")
    expect(main).toContain('releaseVectorSmokeWasRequested(process.argv)')
    expect(main).toContain('claimReleaseVectorSmokeInvocation(process.argv, process.env)')
    expect(main).toContain('runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)')
    expect(main).toContain("process.stdout.write(`${JSON.stringify(evidence)}\\n`)")
    expect(main).toContain('app.exit(0)')
    expect(main).toContain('app.exit(1)')
    expect(main).toContain('[AI Novel release smoke] stage=${stage}')
    expect(main).toContain('Packaged vector smoke timed out after 90 seconds')
  })

  it('has no packaged skin qualification once image skins are gone', () => {
    const main = source('electron/main.ts')

    expect(main).not.toMatch(/release-skin-smoke|ReleaseSkinSmoke|skin-invocation-valid/)
  })
})
