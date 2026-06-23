import { config } from '@fohte/eslint-config'

export default config(
  { typescript: { typeChecked: true } },
  { ignores: ['dist'] },
)
