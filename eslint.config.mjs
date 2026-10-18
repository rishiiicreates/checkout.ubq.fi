import eslint from "@eslint/js";
import tsEslint from "typescript-eslint";

// Preserve the previous recommended lint gate while adopting the template's
// ESLint/TypeScript integration. A wider style migration is outside this cutover.
export default tsEslint.config(
  {
    ignores: [
      "node_modules/**",
      ".worker-build/**",
      ".wrangler/**",
      "worker-configuration.d.ts",
      "public/**",
      "demo/*.js",
      ".codex-worktrees/**",
    ],
  },
  eslint.configs.recommended,
  ...tsEslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
