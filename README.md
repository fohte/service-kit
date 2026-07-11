# service-kit

@fohte's personal cross-language service bootstrap kit, intended to ship as the `@fohte/service-kit` npm package (Node) and the `fohte-service-kit` crate (Rust).

## Scope

Everything in this repository must be both cross-language (implemented for the Node package and the Rust crate alike) and universal enough that any service repository should include it, regardless of what the service does. The [observability conventions](./docs/conventions/observability.md) are the reference example of this bar.

## Packages

| Package                        | Language | Status                                                                                                              |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| [`@fohte/service-kit`](./node) | Node.js  | [![npm version](https://img.shields.io/npm/v/@fohte/service-kit)](https://www.npmjs.com/package/@fohte/service-kit) |
| [`fohte-service-kit`](./rust)  | Rust     | Not yet released                                                                                                    |

### Modules

| Package              | Module          | Provides                                   |
| -------------------- | --------------- | ------------------------------------------ |
| `@fohte/service-kit` | `observability` | OTel + Sentry setup shared across services |

## Conventions

Language-agnostic conventions live under `docs/conventions/`. Each document is the source of truth; how it stays in sync with the Node and Rust implementations is described in the document itself.

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry layout, environment variables, redact rules, startup / shutdown order
