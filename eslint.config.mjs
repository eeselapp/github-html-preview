import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/platform/**', 'src/**/main.ts', 'src/background/service-worker.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'chrome', message: 'Keep extension APIs in a platform adapter; inject scoped capabilities into core code.' },
        { name: 'browser', message: 'Keep extension APIs in a platform adapter; inject scoped capabilities into core code.' },
      ],
    },
  },
);
