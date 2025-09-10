# WebDAV サーバー

高機能な WebDAV サーバーで、画像の自動変換とキャッシュ機能を備えています。

## 概要

このプロジェクトは、複数の設定で WebDAV サーバーを同時起動し、画像ファイルの自動変換（WebP 形式）とキャッシュ機能を提供する Node.js アプリケーションです。

## 主な機能

### 🚀 複数サーバー同時起動

- **軽量版** (ポート 1900): 高速処理重視
- **バランス版** (ポート 1901): 品質と速度のバランス
- **オリジナル版** (ポート 1902): 高品質重視

### 🖼️ 画像自動変換

- 対応形式: JPG, JPEG, PNG, TIFF, TIF, BMP, AVIF
- 出力形式: WebP
- 自動リサイズ（設定に応じて）
- 品質調整（クエリパラメータ `?q=70` で指定可能）

### ⚡ 高性能キャッシュ

- LRU キャッシュによる高速アクセス
- 1MB 以上の画像のみキャッシュ対象
- 自動キャッシュクリーンアップ（5 分 TTL）
- 重複変換の防止機能

### 🛡️ セキュリティ機能

- パストラバーサル攻撃対策
- Depth: infinity の PROPFIND 拒否
- ファイルアクセス制限

## システム要件

- Node.js 16 以上
- ImageMagick（フォールバック用）
- 十分なディスク容量（キャッシュ用）

## インストール

```bash
# 依存関係のインストール
npm install

# ImageMagickのインストール（Windows）
# Chocolateyを使用する場合
choco install imagemagick

# または公式サイトからダウンロード
# https://imagemagick.org/script/download.php#windows
```

## 使用方法

### 基本的な起動

```bash
# v20（最新版）を起動
node webdav_v20.js

# v17（旧版）を起動
node webdav_v17.js

# テスト用のシンプルサーバー
node test.js
```

### アクセス方法

起動後、以下の URL でアクセス可能：

- **軽量版**: http://localhost:1900/
- **バランス版**: http://localhost:1901/
- **オリジナル版**: http://localhost:1902/

### 画像変換の使用例

```
# 通常の画像アクセス
http://localhost:1901/path/to/image.jpg

# 品質指定（30-90の範囲）
http://localhost:1901/path/to/image.jpg?q=80

# 自動リサイズ（設定に応じて）
http://localhost:1901/path/to/large_image.jpg
```

## 設定

### サーバー設定の変更

`webdav_v20.js` の `serverConfigs` 配列を編集：

```javascript
const serverConfigs = [
  {
    PORT: 1900, // ポート番号
    ROOT_PATH: "Z:/", // ルートディレクトリ
    MAX_LIST: 128 * 2, // 最大リスト数
    Photo_Size: 128 * 7, // 画像リサイズサイズ（nullで無効）
    defaultQuality: 50, // デフォルト品質
    label: "v20.0 (軽量版)", // サーバーラベル
  },
  // ...
];
```

### キャッシュ設定

```javascript
const CACHE_DIR = "Y:/caches/webdav/tmp"; // キャッシュディレクトリ
const CACHE_MIN_SIZE = 1 * 1024 * 1024; // キャッシュ最小サイズ（1MB）
const CACHE_TTL_MS = 5 * 60 * 1000; // キャッシュ有効期間（5分）
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // クリーンアップ間隔（30分）
```

## パフォーマンス最適化

### Sharp 設定

- CPU 数に応じた並列処理
- メモリキャッシュの最適化
- 軽量版では最速処理モード

### キャッシュ戦略

- ディレクトリリストキャッシュ（50,000 エントリ）
- ファイル統計キャッシュ（200,000 エントリ）
- 画像変換結果キャッシュ

## トラブルシューティング

### よくある問題

1. **ポートが使用中**

   ```
   ポート 1900 は既に使用されています。v20.0 (軽量版) の起動をスキップします。
   ```

   → 他のプロセスを終了するか、ポート番号を変更してください。

2. **ImageMagick が見つからない**

   ```
   [ImageMagick変換失敗] spawn magick ENOENT
   ```

   → ImageMagick をインストールするか、環境変数 `MAGICK_PATH` を設定してください。

3. **キャッシュディレクトリの権限エラー**
   ```
   [cache write error] EACCES
   ```
   → キャッシュディレクトリの書き込み権限を確認してください。

### ログの確認

サーバーは詳細なログを出力します：

- リクエスト情報
- 変換処理の状況
- エラーとフォールバック処理
- キャッシュの利用状況

## ライセンス

ISC

## 貢献

プルリクエストやイシューの報告を歓迎します。

## 更新履歴

- **v20**: パフォーマンス改善、エラーハンドリング強化
- **v17**: 基本的な WebDAV 機能と画像変換
- **test.js**: シンプルなテスト用サーバー
