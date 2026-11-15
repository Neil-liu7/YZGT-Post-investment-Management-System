import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('native desktop packaging contract', () => {
  it('declares an Electron entry point and both installer targets', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const builder = readFileSync('electron-builder.yml', 'utf8');
    expect(packageJson.main).toBe('desktop/main.mjs');
    expect(builder).toContain('target:\n    - dmg');
    expect(builder).toContain('target:\n    - nsis');
    expect(builder).toContain('from: desktop/runtime');
  });

  it('keeps the native shell away from the better-sqlite3 Electron ABI', () => {
    const main = readFileSync('desktop/main.mjs', 'utf8');
    expect(main).toContain('runtimeBinary');
    expect(main).toContain("scripts', 'start.mjs");
    expect(main).not.toContain("require('better-sqlite3')");
    expect(existsSync('desktop/preload.cjs')).toBe(true);
    expect(existsSync('desktop/onboarding.html')).toBe(true);
  });

  it('provides reproducible runtime fetch and Windows CI entry points', () => {
    expect(readFileSync('scripts/fetch-node-runtime.mjs', 'utf8')).toContain('22.22.2');
    const workflow = readFileSync('.github/workflows/native-build.yml', 'utf8');
    expect(workflow).toContain('windows-2022');
    expect(workflow).toContain('npm run native:win');
  });
});
