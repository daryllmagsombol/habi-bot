import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  /*
   * Mechanical enforcement of `docs/SONAR_GUIDELINES.md`'s idiomatic-form
   * table. Only the idioms lint can decide without judgement are enforced
   * here; the rest are guided by the table and caught by the scan. The reason
   * each rule is present or absent is recorded, so the boundary does not
   * drift:
   *
   *   - `no-duplicate-imports` (S3863), with `allowSeparateTypeImports`
   *     because `consistent-type-imports` above deliberately splits type
   *     imports into their own statement and must not fight this rule.
   *   - `max-nested-callbacks: 4` (S2004), matching Sonar's "more than four
   *     levels" exactly.
   *
   * Deliberately absent, and why:
   *
   *   - `prefer-optional-chain` (S6582): needs typed linting
   *     (`parserOptions.project`), which this repository does not use.
   *     Enabling that is a project-level decision with a real lint-runtime
   *     cost, so the idiom stays guided and scanned rather than half-enforced.
   *   - `no-nested-ternary` (S3358): it cannot tell a value-position chain
   *     from JSX conditional rendering. Sonar flags the first and not the
   *     second, so lint would reject idiomatic React while the actual gate
   *     stays silent. The guideline covers the value-position case.
   *   - Cognitive complexity (S3776) and duplication: these measure different
   *     things than any available ESLint rule, so a local limit would drift
   *     from the real gate.
   */
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'max-nested-callbacks': ['error', 4],
    },
  },
);
