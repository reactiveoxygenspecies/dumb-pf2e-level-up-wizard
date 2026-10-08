import globals from 'globals';
import pluginJs from '@eslint/js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  pluginJs.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        CONFIG: 'readonly',
        CONST: 'readonly',
        ui: 'readonly',
        game: 'readonly',
        Hooks: 'readonly',
        Handlebars: 'readonly',
        ChatMessage: 'readonly',
        fromUuid: 'readonly',
        foundry: 'readonly'
      }
    }
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  {
    rules: {
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'no-console': 'off',
      'no-undef': 'error'
    }
  }
];
