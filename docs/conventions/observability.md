# Observability conventions

`@fohte/service-kit` (Node) と `fohte-service-kit` crate (Rust) が共有する観測層 (telemetry) の規約を定める。本ドキュメントを Source of Truth として扱い、Node / Rust いずれかの実装を変更する場合は両言語の実装と本ドキュメントを同一 PR で更新する。

## 設計方針

### span と error の責務分離

- span / metric / log は OpenTelemetry SDK 経由で OTLP exporter に送信し、Grafana (Tempo / Loki / Mimir 等) で観測する
- error event は Sentry に送る (`Sentry.captureException` 経由、または unhandled exception を Sentry SDK が拾う経路)
- Sentry 側に span を二重送信しないこと。具体的には `SentrySpanProcessor` および `SentrySampler` は組み込まない
- Sentry SDK は trace context の伝播のためにのみ OpenTelemetry に接続する (`SentryPropagator` / `SentryContextManager` を OTel SDK に組み込む)

この分離により、span は Grafana 側でフルに保持しつつ、Sentry の event quota は error にだけ消費される。

## 環境変数

すべての service は以下の環境変数を読む。値は運用側の secret 注入機構 (secret store / CI secret 等) から流し込む想定で、library 側にデフォルト値を持たせない。

| 環境変数                      | 必須 | 用途                                                                |
| ----------------------------- | ---- | ------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes  | OTLP exporter の送信先 URL (例: Grafana Alloy / OTel Collector)     |
| `OTEL_EXPORTER_OTLP_HEADERS`  | yes  | OTLP 認証ヘッダ (例: `Authorization=Basic ...`)                     |
| `OTEL_SERVICE_NAME`           | yes  | `service.name` resource attribute と同値                            |
| `OTEL_RESOURCE_ATTRIBUTES`    | no   | 追加の resource attribute (例: `deployment.environment=production`) |
| `SENTRY_DSN`                  | yes  | Sentry プロジェクトの DSN                                           |
| `SENTRY_ENVIRONMENT`          | yes  | Sentry の environment (例: `production` / `staging`)                |
| `SENTRY_RELEASE`              | no   | リリース識別子 (git commit SHA 等)。CI から注入する                 |

`OTEL_*` 系は OpenTelemetry の標準仕様に従う ([OpenTelemetry Environment Variable Specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/))。library 独自の prefix は導入しない。

## Secret store パスの命名

secret store 上のキーは `/infra/<service>/<resource>` 形式で配置する。

例:

- `/infra/slack-bot/sentry-dsn`
- `/infra/slack-bot/otel-exporter-otlp-headers`

`<resource>` は kebab-case で書き、対応する環境変数名から `_` を `-` に置換した形を基本とする。Terraform 側で `aws_ssm_parameter` リソースを定義し、service の deployment manifest がこのパスを参照して環境変数に注入する。

## Redact パターン

ログ / span attribute / Sentry event に含まれる機密値は、library 側の default redactor が以下のルールで一律に伏字化する。

- key 名が以下の正規表現 (case-insensitive) にマッチする値は redact する
  - `/_TOKEN$/i` (例: `SLACK_BOT_TOKEN`, `github_token`)
  - `/_DSN$/i` (例: `SENTRY_DSN`, `database_dsn`)
  - `/_API_KEY$/i` (例: `OPENAI_API_KEY`)
- HTTP ヘッダ名 `Authorization` (case-insensitive) は値を redact する

redact 後の値は固定文字列 `[REDACTED]` に置き換える。pattern 追加は service 側から options で拡張できる (Node の `extraSecretKeyPatterns` 等。後述)。

## Resource attribute

OTel resource には以下を付与する。

| Attribute                | 必須 | 値の例                                   |
| ------------------------ | ---- | ---------------------------------------- |
| `service.name`           | yes  | `slack-bot` (`OTEL_SERVICE_NAME` と同値) |
| `deployment.environment` | no   | `production` / `staging` / `development` |

`service.name` が無い場合は library が起動時 (init) にエラーで fail-fast する。

## 起動順序

service の bootstrap 時、観測層の初期化は以下の順序で行う。

1. **Sentry init**: `Sentry.init({ dsn, environment, release, ... })` を最初に呼ぶ。Sentry SDK は global state に hook を仕込むため OTel SDK より先である必要がある
2. **OTel SDK 構築**: `NodeSDK` (Node) / `opentelemetry::sdk` (Rust) を構築する。このとき `SentryPropagator` と `SentryContextManager` のみを Sentry 連携として組み込み、span processor / sampler には Sentry 由来のものを入れない
3. **`sdk.start()`**: OTel SDK を起動する
4. **`Sentry.validateOpenTelemetrySetup()`**: Sentry 側の自己診断を呼び、OTel との接続が想定どおりであることを確認する

上記順序を崩すと、Sentry の trace 連携が無効化されたり、span 二重送信が発生したりする。

## Shutdown 順序

SIGTERM / SIGINT を受け取ったら、両 SDK の flush を並行に行う。

```ts
await Promise.allSettled([sdk.shutdown(), Sentry.close(timeoutMs)])
```

- 並行に走らせる: どちらかの flush が遅延しても他方をブロックしない
- `Promise.allSettled` を使う: 片方が reject しても残りを待つ
- idempotent: 二重に SIGTERM が来ても安全に no-op で返るようにすること (`alreadyShuttingDown` フラグで guard)
- timeout: 各 SDK に妥当な timeout (例: 5 秒) を渡し、shutdown が無限にハングしないようにする

Rust 側も同様に `tokio::join!` で OTel exporter の flush と Sentry の `ClientInitGuard` drop / flush を並行に行う。

## Node 章

### API

`@fohte/service-kit/observability` は単一のエントリポイント `initObservability` を export する。

```ts
import { initObservability } from '@fohte/service-kit/observability'

const observability = initObservability(process.env, {
  // 任意の拡張オプション
})

process.on('SIGTERM', () => observability.shutdown())
process.on('SIGINT', () => observability.shutdown())
```

`initObservability(env, options)` は以下を行う。

1. `env` を読み、必須環境変数の不足を fail-fast で検出する
2. Sentry を init する
3. `NodeSDK` を構築し、`SentryPropagator` / `SentryContextManager` を組み込んで `start()` を呼ぶ
4. `Sentry.validateOpenTelemetrySetup()` を呼ぶ
5. `shutdown()` メソッドを持つ handle を返す。`shutdown()` は idempotent で、`Promise.allSettled([sdk.shutdown(), Sentry.close(5000)])` を実行する

### Options 早見表

| Option                   | 型                                              | 用途                                                                                                  |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `extraSecretKeyPatterns` | `RegExp[]`                                      | default の `*_TOKEN` / `*_DSN` / `*_API_KEY` / `Authorization` に追加する redact 対象 key パターン    |
| `extraStringTruncators`  | `Array<{ pattern: RegExp; maxLength: number }>` | 特定のキー名にマッチする string 値を任意長で切り詰める (例: Slack message 本文を 200 文字で truncate) |
| `extraSpanProcessors`    | `SpanProcessor[]`                               | OTel SDK に追加する span processor                                                                    |
| `extraInstrumentations`  | `Instrumentation[]`                             | 追加の auto-instrumentation                                                                           |
| `sentryOptions`          | `Partial<Sentry.NodeOptions>`                   | Sentry init に追加で渡すオプション (`tracesSampleRate` 等)                                            |

例えば slack-bot の `SLACK_MESSAGE_KEY_PATTERN` + 200 文字切詰めは、library 改修を必要とせず以下のように options だけで表現できる。

```ts
initObservability(process.env, {
  extraStringTruncators: [
    { pattern: /^slack\.message\.text$/i, maxLength: 200 },
  ],
})
```

### 依存

`@sentry/node` と `@opentelemetry/*` は重量級のため `peerDependencies` + `peerDependenciesMeta.optional` で宣言する。service 側が必要なバージョンを直接インストールする方針 (`@fohte/service-kit` 本体は薄く保つ)。

## Rust 章

Rust 実装は将来追加する。具体 API は実装時に確定するが、想定する構成は以下のとおり。

- `tracing` + `tracing-subscriber` を log / span の表面 API とする
- `opentelemetry` + `opentelemetry-otlp` で OTLP exporter に送信する
- `sentry` crate (`sentry-rust`) を error reporting に使い、`sentry-tracing` で `tracing` の `event::ERROR` を Sentry に橋渡しする
- Node 側と同じく span を Sentry に二重送信しない (`sentry-opentelemetry` の span 連携は使わず、context 伝播のみ使う方針を検討中)

crate の API シグネチャ、options 名、拡張ポイントは実装時に本ドキュメントに追記する。それまでは本章は規約 (環境変数 / redact / 起動順序 / shutdown 順序) を Rust でどう満たすかの方針宣言として扱う。
