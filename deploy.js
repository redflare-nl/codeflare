// Runs automatically after `npm run package` (postpackage hook):
// removes older packaged .vsix files and installs the freshly built one into
// VSCode, so you only need to reload the window to pick up the new version.
const { execSync } = require('child_process');
const fs = require('fs');
const pkg = require('./package.json');

const vsix = `codeflare-${pkg.version}.vsix`;

// Remove any older codeflare-*.vsix so only the current build remains.
for (const f of fs.readdirSync('.')) {
  if (/^codeflare-.*\.vsix$/.test(f) && f !== vsix) {
    try { fs.unlinkSync(f); console.log('removed old package:', f); } catch { /* ignore */ }
  }
}

// Install the new build. --force replaces the previously installed version.
try {
  execSync(`code --install-extension ${vsix} --force`, { stdio: 'inherit' });
  console.log(`\nInstalled ${vsix}. Reload the VSCode window (Developer: Reload Window) to activate it.`);
} catch (err) {
  console.warn(`\nCould not auto-install ${vsix} (is the 'code' CLI on PATH?). Install it manually if needed.`);
}
