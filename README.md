# service-kit

@fohte's personal cross-language service bootstrap kit, intended to ship as the `@fohte/service-kit` npm package (Node) and the `fohte-service-kit` crate (Rust).

## Status

| Package              | Status                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@fohte/service-kit` | [![npm version](https://img.shields.io/npm/v/@fohte/service-kit)](https://www.npmjs.com/package/@fohte/service-kit) |
| `fohte-service-kit`  | Not yet released                                                                                                    |

## Packages

| Package                        | Language | Provides                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------- |
| [`@fohte/service-kit`](./node) | Node.js  | Observability (OpenTelemetry + Sentry) setup shared across services |
| `fohte-service-kit`            | Rust     | Not yet implemented                                                 |

## Conventions

Language-agnostic conventions live under `docs/conventions/`. Each document is the source of truth; how it stays in sync with the Node and Rust implementations is described in the document itself.

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry layout, environment variables, redact rules, startup / shutdown order
