# service-kit

@fohte's personal cross-language service bootstrap kit, intended to ship as the `@fohte/service-kit` npm package (Node) and the `fohte-service-kit` crate (Rust).

## Status

Pre-release. No library code is published yet; this repository currently ships only the cross-language conventions under `docs/conventions/`. Install and usage instructions will be added once the first release lands.

## Conventions

Language-agnostic conventions live under `docs/conventions/`. Each document is the source of truth; how it stays in sync with the Node and Rust implementations is described in the document itself.

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry layout, environment variables, redact rules, startup / shutdown order
