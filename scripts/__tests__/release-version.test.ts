import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  it('has a valid package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u)
  })

  it('resolves the exact seven-asset contract from the package version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const profile = JSON.parse(readFileSync('.release/release-profile.json', 'utf8')) as {
      releaseAssets: Array<{ name: string }>
      releaseChannel: { draft: boolean; prerelease: boolean; expectedLatest: boolean }
    }

    expect(profile.releaseChannel).toEqual({ draft: false, prerelease: false, expectedLatest: true })
    expect(profile.releaseAssets.map(({ name }) => name.replaceAll('{version}', pkg.version))).toEqual([
      `ai-novel-writer-setup-${pkg.version}.exe`,
      `ai-novel-writer-setup-${pkg.version}.exe.blockmap`,
      'latest.yml',
      `ai-novel-writer-mac-arm64-${pkg.version}-installer.dmg`,
      `ai-novel-writer-mac-arm64-${pkg.version}-installer.dmg.sha256`,
      `ai-novel-writer-mac-x64-${pkg.version}-installer.dmg`,
      `ai-novel-writer-mac-x64-${pkg.version}-installer.dmg.sha256`,
    ])
  })

  it('documents current desktop downloads and signing disclosures in both READMEs', () => {
    const chineseReadme = readFileSync('README.md', 'utf8')
    const englishReadme = readFileSync('README_en.md', 'utf8')

    for (const readme of [chineseReadme, englishReadme]) {
      for (const expected of [
        'Windows x64',
        'Apple Silicon',
        'Intel',
      ]) expect(readme).toContain(expected)

      for (const installer of [
        /ai-novel-writer-setup-<[^>\r\n]+>\.exe/u,
        /ai-novel-writer-mac-arm64-<[^>\r\n]+>-installer\.dmg/u,
        /ai-novel-writer-mac-x64-<[^>\r\n]+>-installer\.dmg/u,
      ]) expect(readme).toMatch(installer)
    }

    for (const expected of [
      '未进行代码签名',
      'ad-hoc 签名',
      '未使用 Developer ID 签名或公证',
    ]) expect(chineseReadme).toContain(expected)

    for (const expected of [
      'not code-signed at present',
      'ad-hoc signed',
      'not notarized',
    ]) expect(englishReadme).toContain(expected)
  })
})
