// Driver for the extension-host runners: boots VS Code stable with the
// extension under test and runs the requested runner (default: the T1 spike)
// from out-test/ inside the extension host. Exit 0 = PASS, non-zero = FAIL
// (runTests rejects when the CLI exit code is non-zero).
'use strict';

const fs = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

// @vscode/test-electron spawns VS Code with `shell: true` on Windows and
// concatenates argv entries without quoting. A repo path containing spaces is
// truncated at the first space (e.g. 'F:\Downloads\Git\VSCode'), which breaks
// --extensionDevelopmentPath / --extensionTestsPath. Work around it by
// pointing those args at a space-free junction next to the repo.
function repoPathForLauncher(repoRoot) {
  if (!/\s/.test(repoRoot)) return repoRoot;
  const junction = path.join(path.dirname(repoRoot), 'frm-fallback');
  let stat = null;
  try {
    stat = fs.lstatSync(junction);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (stat) {
    const target = fs.realpathSync(junction);
    if (target !== fs.realpathSync(repoRoot)) {
      throw new Error(`junction ${junction} exists but points to ${target}, expected ${repoRoot}`);
    }
  } else {
    fs.symlinkSync(repoRoot, junction, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return junction;
}

// The companion extension declares extensionDependencies: ["vicanent.gcmp"]
// (T2). A bare extension host refuses to activate it when the dependency is
// missing, which fails the spike before any probe runs. Provide a minimal
// DORMANT stand-in (no LM providers, no-op activate) via --extensions-dir so
// the dependency check passes; the spike never needs real GCMP.
// Idempotent: only created once under .vscode-test (gitignored).
function ensureGcmpStub(launchPath) {
  const stubRoot = path.join(launchPath, '.vscode-test', 'stub-extensions');
  const stubDir = path.join(stubRoot, 'vicanent.gcmp');
  const pkgFile = path.join(stubDir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    const pkg = {
      name: 'gcmp',
      displayName: 'GCMP Stub (spike fixture)',
      description: 'Minimal stand-in for vicanent.gcmp so the extension-host spike can activate its companion extension.',
      publisher: 'vicanent',
      version: '0.28.1',
      engines: { vscode: '^1.125.0' },
      main: './main.js',
      activationEvents: ['onStartupFinished'],
    };
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(stubDir, 'main.js'), 'exports.activate = () => {}; exports.deactivate = () => {};\n');
    console.log(`gcmp dependency stub created at ${stubDir}`);
  }
  return stubRoot;
}

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const runner = process.argv[2] || 'spike.runner.js';
  try {
    const launchPath = repoPathForLauncher(repoRoot);
    const stubExtRoot = ensureGcmpStub(launchPath);
    await runTests({
      version: 'stable',
      extensionDevelopmentPath: launchPath,
      extensionTestsPath: path.join(launchPath, 'out-test', runner),
      launchArgs: ['--extensions-dir', stubExtRoot],
    });
    console.log(`${runner} completed (exit 0)`);
    process.exit(0);
  } catch (e) {
    console.error(`${runner} failed:`, e && e.message ? e.message : e);
    process.exit(1);
  }
})();
