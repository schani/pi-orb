import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/src/**/*.ts", "**/src/**/*.tsx"],
    rules: {
      // First-party code returns neverthrow Results; throwing is reserved for
      // documented framework boundaries with a narrow inline disable.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ThrowStatement",
          message:
            "Return a neverthrow Result instead of throwing. Boundary overrides must be narrow and documented.",
        },
      ],
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/testkit/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
