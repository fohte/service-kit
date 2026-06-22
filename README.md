# service-kit

@fohte's personal cross-language service bootstrap kit (@fohte/service-kit for Node, fohte-service-kit crate for Rust)

## Conventions

言語非依存の規約は `docs/conventions/` 配下に置く。Node / Rust いずれかの実装を変更する際は、対応する規約ドキュメントと両言語の実装を同一 PR で更新する。

- [Observability conventions](./docs/conventions/observability.md): OTel + Sentry の構成、環境変数、redact、起動 / shutdown 順序
