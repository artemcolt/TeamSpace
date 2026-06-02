import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const sourceApp = join(projectRoot, 'node_modules/electron/dist/Electron.app');
const workspaceApp = join(projectRoot, 'build/dev/Workspace.app');
const infoPlist = join(workspaceApp, 'Contents/Info.plist');
const workspaceIcon = join(projectRoot, 'build/icon.icns');
const workspacePngIcon = join(projectRoot, 'build/icon.png');
const bundledIcon = join(workspaceApp, 'Contents/Resources/electron.icns');
const bundledPngIcon = join(workspaceApp, 'Contents/Resources/icon.png');
const sourceExecutable = join(workspaceApp, 'Contents/MacOS/Electron');
const workspaceExecutable = join(workspaceApp, 'Contents/MacOS/Workspace');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(sourceApp)) {
  console.error(`Electron.app not found at ${sourceApp}`);
  process.exit(1);
}

mkdirSync(join(projectRoot, 'build/dev'), { recursive: true });
run('rsync', ['-a', '--delete', `${sourceApp}/`, `${workspaceApp}/`]);

run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName Workspace', infoPlist]);
run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Workspace', infoPlist]);
run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.teamspace.workspace.dev', infoPlist]);
run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable Workspace', infoPlist]);
copyFileSync(sourceExecutable, workspaceExecutable);
chmodSync(workspaceExecutable, 0o755);
if (existsSync(workspaceIcon)) {
  copyFileSync(workspaceIcon, bundledIcon);
}
if (existsSync(workspacePngIcon)) {
  copyFileSync(workspacePngIcon, bundledPngIcon);
}

const electron = spawn(workspaceExecutable, [projectRoot], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit'
});

electron.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
