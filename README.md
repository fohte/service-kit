# service-kit

@fohte's personal cross-language service bootstrap kit (@fohte/service-kit for Node, fohte-service-kit crate for Rust)

## Conventions

Language-agnostic conventions live under `docs/conventions/`. Each document is the source of truth; how it stays in sync with the Node and Rust implementations is described in the document itself.

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry layout, environment variables, redact rules, startup / shutdown order
