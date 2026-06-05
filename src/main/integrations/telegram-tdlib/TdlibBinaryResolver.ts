import path from 'node:path';

export function tdlibLibraryName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'libtdjson.dylib';
  }
  if (platform === 'win32') {
    return 'tdjson.dll';
  }
  return 'libtdjson.so';
}

export function resolveTdlibLibraryPath(options: {
  platform: NodeJS.Platform;
  resourcesPath: string;
  appPath: string;
  isPackaged?: boolean;
}): string {
  const fileName = tdlibLibraryName(options.platform);
  return options.isPackaged
    ? path.join(options.resourcesPath, 'tdlib', fileName)
    : path.join(options.appPath, 'build', 'tdlib', options.platform, fileName);
}
