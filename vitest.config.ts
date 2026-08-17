import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Postgres tests share one database; run files serially so they cannot
    // interfere through the shared catalog rows.
    fileParallelism: false,
    testTimeout: 20000,
  },
  resolve: { alias: { '@': path.join(__dirname, 'src') } },
});
