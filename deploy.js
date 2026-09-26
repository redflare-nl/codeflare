// Explicit deployment: `npm run deploy`. Packaging alone never installs.
// Older packages are retained so a known-good VSIX can be selected for rollback.
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');
const { resolveCodeCommand, installVsix } = require('./scripts/self-update-recovery.cjs');

const vsix = path.resolve(process.argv[2] || `codeflare-${pkg.version}.vsix`);
try {
  if (!fs.statSync(vsix).isFile()) { throw new Error(`VSIX is not a file: ${vsix}`); }
  installVsix(resolveCodeCommand(process.env.CODEFLARE_VSCODE_CLI || 'code'), vsix);
  console.log(`Installed ${vsix}. Reload the VS Code window to activate it. Older VSIX packages were preserved.`);
} catch (err) {
  console.error(`Could not install ${vsix}: ${err.message}`);
  process.exitCode = 1;
}
