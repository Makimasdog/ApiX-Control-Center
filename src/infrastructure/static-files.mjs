import {join} from 'node:path';

// Public URLs stay stable while source files live with the frontend.
const assets = new Map([
  ['index.html', 'web/index.html'],
  ['agent-os.js', 'web/agent-os.js'],
  ...['styles', 'phase4', 'director', 'coordinator', 'overview', 'desktop', 'assistant']
    .map(name => [`${name}.css`, `web/styles/${name}.css`]),
]);

export function staticFilePath(root, relativePath) {
  const asset = assets.get(relativePath);
  if (asset) return join(root, asset);
  if (relativePath === 'dist/src/assistant-result.js') return join(root, 'dist/src/assistant/assistant-result.js');
  if (relativePath === 'dist/src/assistant/assistant-result.js' || /^dist\/web\/[a-zA-Z0-9_-]+\.js$/.test(relativePath)) {
    return join(root, relativePath);
  }
  return null;
}
