import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import jest from "eslint-plugin-jest";
import obsidianmd from "eslint-plugin-obsidianmd";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";

const serviceFiles = [
  "src/ClaudianService.ts",
  "src/InlineEditService.ts",
  "src/InstructionRefineService.ts",
  "src/images/**/*.ts",
  "src/prompt/**/*.ts",
  "src/sdk/**/*.ts",
  "src/security/**/*.ts",
  "src/tools/**/*.ts",
];

const jestRecommended = jest.configs["flat/recommended"];

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "coverage/", "main.js"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
       // TypeScript handles name resolution; disable redundant ESLint no-undef for TS files
       "no-undef": "off",
       "@typescript-eslint/no-unsafe-assignment": "warn",
       "@typescript-eslint/no-unsafe-call": "warn",
       "@typescript-eslint/no-unsafe-member-access": "warn",
       "@typescript-eslint/no-unsafe-argument": "warn",
       "@typescript-eslint/no-unsafe-return": "warn",
       "@typescript-eslint/unbound-method": "warn",
       "@typescript-eslint/no-unsafe-enum-comparison": "warn",
       "@typescript-eslint/consistent-type-imports": [
         "error",
         { prefer: "type-imports", fixStyle: "separate-type-imports" },
       ],
       "@typescript-eslint/no-unused-vars": [
         "error",
         { args: "none", ignoreRestSiblings: true },
       ],
       "@typescript-eslint/no-explicit-any": "off",
       "simple-import-sort/imports": "error",
       "simple-import-sort/exports": "error",
     },
  },
  {
    files: serviceFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./ui", "./ui/*", "../ui", "../ui/*"],
              message: "Service and shared modules must not import UI modules.",
            },
            {
              group: ["./ClaudianView", "../ClaudianView"],
              message: "Service and shared modules must not import the view.",
            },
          ],
        },
      ],
    },
  },
  {
    ...jestRecommended,
    files: ["tests/**/*.ts"],
    rules: {
      ...(jestRecommended.rules ?? {}),
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Disable obsidianmd plugin-specific rules in test files
  // These rules enforce plugin production code patterns that are intentionally
  // violated in test fixtures (mock TFile/TFolder objects, test style checks, etc.)
  {
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/no-tfile-tfolder-cast": "off",
      "obsidianmd/no-static-styles-assignment": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-forbidden-elements": "off",
    },
  },
]);
