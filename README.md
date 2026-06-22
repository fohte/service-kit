# service-kit

@fohte's personal cross-language service bootstrap kit (@fohte/service-kit for Node, fohte-service-kit crate for Rust)

## Conventions

言語非依存の規約は `docs/conventions/` 配下に置く。各ドキュメントを Source of Truth として扱い、規約と Node / Rust 実装の同期方針は各規約ドキュメント側に記載する。

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry の構成、環境変数、redact、起動 / shutdown 順序
