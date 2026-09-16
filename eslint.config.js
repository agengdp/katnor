import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/drizzle/**",
      "**/coverage/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  // `no-undef` (from js.configs.recommended) only knows the globals a config
  // actually declares - ESLint's flat config has no `env: { browser: true }`
  // shorthand, so without these two blocks every `console`/`process` in the
  // Node packages and every DOM identifier in apps/web (`fetch`, `document`,
  // `SubmitEvent`, `HTMLSelectElement`, `requestAnimationFrame`, ...) is
  // reported as undefined. Flat config merges `globals` across every config
  // object that matches a file, so apps/web ends up with both sets.
  {
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ["apps/web/**"],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser
    }
  },
  {
    files: ["apps/web/**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".svelte"]
      }
    }
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  }
);
