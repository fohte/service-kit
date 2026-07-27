import { config } from '@fohte/eslint-config'

export default config(
  { typescript: { typeChecked: true }, errorHandling: {} },
  { ignores: ['dist'] },
  {
    rules: {
      // Conflicts with this repo's test convention (see CLAUDE.md), which
      // requires comparing the whole expected output as a single literal
      // via one equality assertion, including when the "output" is a
      // synthetic record of several related values under test.
      'fohte/no-inline-object-in-expect': 'off',
    },
  },
  {
    // This package publishes only `dist` (see package.json "files"), so a `#`
    // subpath import surviving into the compiled output would resolve via
    // "imports" to a `./src/*.ts` path that doesn't exist for npm consumers.
    // Relative imports compile to relative dist paths that always resolve,
    // so these files (which cross-reference other observability modules and
    // ship in the published bundle) are exempt from the relative-import ban.
    files: ['src/observability/index.ts', 'src/observability/init.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
)
