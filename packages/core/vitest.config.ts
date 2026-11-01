import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // §22 rule 28: the policy engine and combiner need 100% branch coverage.
      thresholds: {
        "src/policy/**": { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
