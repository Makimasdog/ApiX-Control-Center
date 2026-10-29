module.exports = {
  appId: 'local.apix.controlcenter',
  productName: 'ApiX Control Center',
  directories: { app: '.tmp-desktop/shell', output: '.tmp-desktop/release' },
  electronVersion: require('../package.json').devDependencies.electron,
  electronDist: 'node_modules/electron/dist',
  files: ['*.cjs', 'package.json'],
  extraResources: [
    { from: '.tmp-desktop/backend', to: 'backend' },
    // electron-builder always excludes a source directory's top-level node_modules.
    { from: '.tmp-desktop/backend/node_modules', to: 'backend/node_modules' },
  ],
  asar: true,
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false, artifactName: 'ApiX-Setup-${version}-${arch}.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, runAfterFinish: false, deleteAppDataOnUninstall: false },
};
