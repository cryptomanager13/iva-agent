import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    ".output/",
    "node_modules/",
    "patches/",
    "assets/",
    "vault-template/",
    ".eve/",
    "services/telegram-userbot/",
    "data/",
    ".scratch/",
    ".worktrees/",
    ".claude/",
    "**/wt/",
    "**/.workflow-data/",
    "**/.iva-update/",
    "**/.iva-build/",
    "**/.output.iva-backup-*/",
    "**/.output.iva-install-backup-*/",
    "**/.output.iva-build-backup-*/",
  ]),
  {
    name: "iva/javascript",
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    name: "iva/typescript",
    files: ["**/*.{ts,mts}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "Enums require TypeScript transformation and cannot run under Node.js type stripping.",
        },
        {
          selector: "TSModuleDeclaration",
          message:
            "Namespaces require TypeScript transformation and cannot run under Node.js type stripping.",
        },
        {
          selector: "TSParameterProperty",
          message:
            "Parameter properties require TypeScript transformation and cannot run under Node.js type stripping.",
        },
      ],
    },
  },
  eslintConfigPrettier,
]);
