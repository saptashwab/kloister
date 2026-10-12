// @ts-check
/**
 * Single ESLint flat config for every workspace.
 *
 * - TypeScript files get the type-aware typescript-eslint rules.
 * - Angular files additionally get angular-eslint (TS + templates).
 * - Exported symbols must carry a doc comment (SPEC §11); tests are exempt.
 * - Prettier owns formatting, so stylistic rules are switched off last.
 */
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.angular/'],
  },

  // Plain JS config files (eslint/jest configs) run in Node.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // All TypeScript, with type information from each workspace's tsconfig.
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Nest modules are decorated empty classes by design.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  // Doc comments on every exported symbol (SPEC §11).
  {
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSEnumDeclaration',
            'ExportNamedDeclaration > VariableDeclaration',
          ],
          checkConstructors: false,
          // A fixer would insert empty /** */ stubs that satisfy the rule
          // without documenting anything.
          enableFixer: false,
        },
      ],
      // SPEC §11 asks for purpose and parameters, not just a comment block.
      'jsdoc/require-description': 'error',
      'jsdoc/require-param': ['error', { checkConstructors: false, enableFixer: false }],
      'jsdoc/require-returns': ['error', { publicOnly: true }],
    },
  },

  // Angular component and directive rules for the web app.
  {
    files: ['apps/web/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },

  prettier,
);
