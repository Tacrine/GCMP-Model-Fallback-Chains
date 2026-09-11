// T1 spike driver: boots VS Code stable with the extension under test and runs
// out-test/spike.runner.js inside the extension host. Exit 0 = gate PASS,
// non-zero = FAIL (runTests rejects when the CLI exit code is non-zero).
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

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  try {
    const launchPath = repoPathForLauncher(repoRoot);
    await runTests({
      version: 'stable',
      extensionDevelopmentPath: launchPath,
      extensionTestsPath: path.join(launchPath, 'out-test', 'spike.runner.js'),
    });
    console.log('spike runner completed (exit 0)');
    process.exit(0);
  } catch (e) {
    console.error('spike harness failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
