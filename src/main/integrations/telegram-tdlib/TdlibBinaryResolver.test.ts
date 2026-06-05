import { describe, expect, it } from 'vitest';
import { resolveTdlibLibraryPath, tdlibLibraryName } from './TdlibBinaryResolver';

describe('TdlibBinaryResolver', () => {
  it('uses platform-specific library names', () => {
    expect(tdlibLibraryName('darwin')).toBe('libtdjson.dylib');
    expect(tdlibLibraryName('linux')).toBe('libtdjson.so');
    expect(tdlibLibraryName('win32')).toBe('tdjson.dll');
  });

  it('resolves development path under build resources', () => {
    expect(resolveTdlibLibraryPath({
      platform: 'darwin',
      resourcesPath: '/Applications/Workspace.app/Contents/Resources',
      appPath: '/repo'
    })).toBe('/repo/build/tdlib/darwin/libtdjson.dylib');
  });

  it('resolves packaged path under Electron resources', () => {
    expect(resolveTdlibLibraryPath({
      platform: 'win32',
      resourcesPath: 'C:\\Workspace\\resources',
      appPath: 'C:\\repo',
      isPackaged: true
    })).toContain('tdlib');
    expect(resolveTdlibLibraryPath({
      platform: 'win32',
      resourcesPath: 'C:\\Workspace\\resources',
      appPath: 'C:\\repo',
      isPackaged: true
    })).toContain('tdjson.dll');
  });
});
