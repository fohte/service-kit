import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'observability/index': 'src/observability/index.ts',
  },
  format: ['cjs', 'esm'],
  outDir: 'dist',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  // .d.ts is emitted by `tsc -p tsconfig.build.json`.
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  // Explicit to prevent a stray dynamic import from being inlined.
  external: [
    '@opentelemetry/api',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-node',
    '@opentelemetry/semantic-conventions',
    '@sentry/node',
    '@sentry/opentelemetry',
  ],
})
