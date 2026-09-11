import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The T1 spike downloads a full VS Code install into .vscode-test/ (also
    // emitted build output out/ and out-test/). Never scan those trees.
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', '.vscode-test/**', 'out/**', 'out-test/**'],
  },
});
