// Shared flat ESLint config for the AIRun monorepo.
// Placeholder — real rules added when package implementation starts.
/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", ".turbo/**", "node_modules/**"],
  },
];
