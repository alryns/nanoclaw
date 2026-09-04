import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // Channel registration tests change process.cwd() to exercise per-file .env input.
    // Forks provide the required process isolation for that global state.
    pool: 'forks',
    fileParallelism: false,
    // Slack's registration test dynamically imports the complete channel barrel.
    // On a cold transform cache that can exceed Vitest's 10-second hook default.
    hookTimeout: 30_000,
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
  },
});
