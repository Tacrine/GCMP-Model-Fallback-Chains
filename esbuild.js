const esbuild = require('esbuild');

const args = process.argv.slice(2);

if (args.includes('--qa')) {
  // QA fault-injection driver (plan T10): bundle the TS driver + src core into
  // a runnable node ESM file. test/** is excluded from the VSIX, so nothing
  // here ships in the extension.
  esbuild.build({
    entryPoints: ['test/qa/faults.ts'],
    bundle: true,
    outfile: 'test/qa/faults.bundle.mjs',
    platform: 'node',
    target: 'node18',
    format: 'esm',
    external: [],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  }).catch(() => process.exit(1));
  return;
}

if (args.includes('--spike')) {
  // T1 spike gate runner (extension-host). test/** is excluded from the VSIX,
  // so nothing here ships in the extension. The runner runs inside the
  // extension host, so 'vscode' must stay external; node builtins are
  // external by default on platform 'node'.
  esbuild.build({
    entryPoints: ['test/e2e/spike.runner.ts'],
    bundle: true,
    outfile: 'out-test/spike.runner.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  }).catch(() => process.exit(1));
  return;
}

esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
}).catch(() => process.exit(1));
