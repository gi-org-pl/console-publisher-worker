import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    clearMocks: true,
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
