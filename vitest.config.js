import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // Pure modules run in node; DOM tests opt in per file with `// @vitest-environment happy-dom`.
    environment: 'node'
  }
});
