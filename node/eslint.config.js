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
)
