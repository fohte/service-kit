import { config } from '@fohte/eslint-config'

<<<<<<< before updating
export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
    opentelemetry: { enabled: true },
  },
  { ignores: ['dist'] },
  {
    // This package publishes only `dist` (see package.json "files"), so a `#`
    // subpath import surviving into the compiled output would resolve via
    // "imports" to a `./src/*.ts` path that doesn't exist for npm consumers.
    // Relative imports compile to relative dist paths that always resolve,
    // so these files (which cross-reference other observability/env/retry
    // modules and ship in the published bundle) invert the base rule: `#`
    // subpath imports are banned here instead of required.
    files: [
      'src/observability/index.ts',
      'src/observability/init.ts',
      'src/observability/sentry.ts',
      'src/env/index.ts',
      'src/langchain-genai/index.ts',
      'src/retry/index.ts',
      'src/logger/index.ts',
      'src/logger/logger.ts',
      'src/logger/redact.ts',
      'src/shutdown/index.ts',
      'src/shutdown/shutdown.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // A leading `#` is a comment in gitignore-style pattern
              // matching (used by no-restricted-imports patterns), so it
              // must be escaped to match a literal `#` subpath import.
              group: ['\\#*'],
              message:
                'A # subpath import here compiles unresolved into dist and only fails at runtime for npm consumers, since this package publishes only dist (see package.json "files"). Use a relative import instead.',
            },
            {
              group: ['@/*'],
              message:
                'The @ alias is not allowed: it only exists for TypeScript/bundlers and is not resolved by Node at runtime. Use a relative import instead.',
            },
          ],
        },
      ],
    },
  },
)
||||||| last update
export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
  },
)
=======
export default config({
  typescript: { typeChecked: true },
  errorHandling: {},
})
>>>>>>> after updating
