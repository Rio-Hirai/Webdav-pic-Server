# Webdav-pic-Server — Copilot への指示（日本語）

このリポジトリは、単一プロセスで動作する Node.js ベースの WebDAV 画像変換サーバーです。画像は要求時に Sharp によって変換され、HEIC/HEIF 等は ImageMagick にフォールバックします。設定は `config.txt` から動的に読み込まれ、10秒ごとに反映されます。主要なコードは `main.js` と `.core/` 以下にあります。

編集する前に知っておくこと（要点）:
- `main.js`：起動処理、`configureSharp()`、設定監視、再起動フック
- `.core/config.js`：設定の検証と動的取得（`config.txt` がソース・オブ・トゥルース）
- `.core/image.js`：`convertAndRespond()`、`reinitializeConcurrency()`、in-flight デデュープ、`p-limit` による並列制御
- `.core/webdav.js`：WebDAV ルーティング、`safeResolve`（パストラバーサル対策）、`IMAGE_EXTS`、キャッシュラッパー
- `.core/cache.js`：ファイル/LRU キャッシュ、TTL、原子的書き込み

起動・デバッグの簡易コマンド:
- `npm run start`（フォアグラウンド）。Windows のバックグラウンドでは `npm run start:bg` を使用
- `node test.js`（簡易テストサーバー、ポート1901）
- `npm run logs`（PowerShell でログを tail）、`npm run status`（netstat チェック）
- `config.txt` を編集後、10秒以内に設定が自動適用されることを確認

エージェント（AI）に対する作業ルール:
- 影響範囲は小さくする（挙動変更は `.core/*` に限定）。ランタイム設定は `config.txt` の編集で行う
- 並列／メモリ設定を変更する場合は、`main.js` の `configureSharp()` と `.core/image.js` の `p-limit` 初期化（`reinitializeConcurrency()`）の両方を更新すること
- キャッシュの挙動を変える場合、SHA-256 によるキャッシュキー生成と Windows のパス長制限回避処理（`.core/webdav.js` / `.core/cache.js`）を確認すること
- パス解決やアクセス制御に影響する変更は `safeResolve` を使い、プラットフォーム別テスト（パストラバーサル攻撃パターン）を行うこと

テストチェックリスト（手動）:
- サーバー起動: `npm run start` または `node main.js`
- 画像リクエスト: `curl -I http://localhost:1900/path/to/image.jpg?q=80` → `200` と `Content-Type: image/webp` を期待
- HEIC のフォールバック: `curl -I http://localhost:1900/path/to/image.heic`（ImageMagick が必要）
- `config.txt` の変更が 10 秒以内に反映されることをログで確認

依存関係と環境:
- Node.js >= 25
- `sharp` (0.34.4), `webdav-server`, `p-limit`, `lru-cache` など。HEIC 用の ImageMagick は別途必要

エージェント応答の言語ポリシー:
- ユーザー向けの説明・コメント・要約は日本語で出力してください。
- コマンド、ファイル名、コードのスニペットなどの技術的表現は英語で記載して構いません。

そのほか（任意）:
- `package.json` に PM2 用の start スクリプトを追加する
- 並列やセキュリティに関する変更向けの PR テンプレートを追加する

---

注意: `.github/copilot-instructions.md` を編集する際は、必ず本ファイル（`.github/copilot-instructions.ja.md`）も同様に更新してください（英語→日本語の同期）。
