const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', 'canvas', 'sql.js/dist/sql-wasm.wasm'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
  plugins: [{
    name: 'standalone-recovery-helper',
    setup(build) {
      build.onEnd(result => {
        if (result.errors.length) { return; }
        fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
        for (const name of ['self-update-recovery.cjs', 'self-update-smoke.cjs']) {
          fs.copyFileSync(path.join(__dirname, 'scripts', name), path.join(__dirname, 'dist', name));
        }
        fs.copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), path.join(__dirname, 'dist', 'sql-wasm.wasm'));
      });
    },
  }],
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  esbuild.build(buildOptions).then(() => {
    console.log('Build complete');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
