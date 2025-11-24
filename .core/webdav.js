// === WebDAVサーバーシステムモジュール ===
const fs = require("fs"); // ファイルシステム操作 - 同期/非同期ファイルI/O、ディレクトリ操作、opendirSync等のストリーミングAPI
const path = require("path"); // パス操作 - クロスプラットフォーム対応のパス解決、正規化、セキュリティチェック用
const http = require("http"); // HTTPサーバー - 低レベルHTTPサーバー実装、Keep-Alive、タイムアウト設定
const crypto = require("crypto"); // 暗号化・ハッシュ生成 - MD5/SHA256等のハッシュ関数、キャッシュキー生成用
const os = require("os"); // OS情報取得 - CPU数、メモリ情報、プラットフォーム判定、並列度最適化用
const stream = require("stream"); // ストリーム処理 - PassThrough、pipeline等のストリーム操作、メモリ効率化
const { promisify } = require("util"); // コールバック→Promise変換 - 非同期処理の統一化、pipelineのPromise化
const { execFile, spawn } = require("child_process"); // 外部プロセス実行 - ImageMagick等の外部コマンド呼び出し、フォールバック処理
const zlib = require("zlib"); // レスポンス圧縮処理 - gzip/deflate圧縮

// 外部ライブラリ
const sharp = require("sharp"); // 画像変換ライブラリ - libvipsベース、WebP/JPEG/PNG変換、メタデータ取得、回転補正
const webdav = require("webdav-server").v2; // WebDAVサーバー実装 - RFC4918準拠のWebDAVプロトコル、PROPFIND/PROPPATCH等
const pLimit = require("p-limit"); // 並列処理制御 - 同時実行数の制限によるリソース保護、メモリ枯渇防止
const { LRUCache } = require("lru-cache"); // LRUキャッシュ管理 - 最近使用されたエントリを優先保持、メモリ効率化

// 設定管理モジュール
const {
  logger, // ロギング機能 - ログ出力、ログレベル、ログファイル管理
  getDynamicConfig, // 動的設定取得 - 設定値の動的取得
  getCompressionEnabled, // 圧縮有効フラグ - 圧縮機能の有効/無効
  getCompressionThreshold, // 圧縮閾値 - 圧縮閾値
  getImageConversionEnabled, // 画像変換有効フラグ - 画像変換機能の有効/無効
  getCacheMinSize, // キャッシュ最小サイズ - キャッシュが有効なファイルサイズの最小値
  getCacheTTL, // キャッシュTTL - キャッシュの有効期限
  getServerPort, // サーバーポート - WebDAVサーバーのポート番号
  getServerRootPath, // サーバールートパス - WebDAVサーバーのルートディレクトリパス
} = require("./config"); // 設定管理モジュール

// 画像変換モジュール
const { convertAndRespond, convertAndRespondWithLimit } = require("./image"); // 画像変換モジュール
const {
  recordImageTransfer,
  recordTextCompression,
  getStatsSnapshot,
} = require("./stats");

const PassThrough = stream.PassThrough; // ストリーム処理 - PassThrough、pipeline等のストリーム操作、メモリ効率化
const pipeline = promisify(stream.pipeline); // ストリーム処理 - PassThrough、pipeline等のストリーム操作、メモリ効率化

/**
 * WebDAVサーバー起動関数
 * config.txtの設定でWebDAVサーバーとHTTPサーバーを起動して画像変換機能を提供
 *
 * @param {string|null} activeCacheDir - アクティブキャッシュディレクトリ
 */
function startWebDAV(activeCacheDir) {
  // config.txtから動的に設定を読み込み
  const PORT = getServerPort(); // サーバーポート - WebDAVサーバーのポート番号
  const ROOT_PATH = getServerRootPath(); // サーバールートパス - WebDAVサーバーのルートディレクトリパス

  // 動的設定読み込み関数
  const getPhotoSize = () => getDynamicConfig("PHOTO_SIZE", 1024); // 写真サイズ - 写真サイズ
  const getMaxList = () => getDynamicConfig("MAX_LIST", 1280); // 最大リスト数 - 最大リスト数
  const getDefaultQuality = () => getDynamicConfig("DEFAULT_QUALITY", 70); // デフォルト品質 - デフォルト品質

  // 画像変換対象の拡張子リスト
  const IMAGE_EXTS = [
    ".jpg", // JPEG画像
    ".jpeg", // JPEG画像
    ".png", // PNG画像
    ".tiff", // TIFF画像
    ".tif", // TIFF画像
    ".bmp", // BMP画像
    ".avif", // AVIF画像
    ".heic", // HEIC画像
    ".heif", // HEIF画像
  ];

  // キャッシュTTL設定
  const DIR_TTL = 60 * 60 * 1000; // 1時間 - ディレクトリリストキャッシュの有効期限
  const STAT_TTL = 60 * 60 * 1000; // 1時間 - ファイル統計情報キャッシュの有効期限

  /**
   * LRUキャッシュインスタンスの作成
   * メモリ効率的なキャッシュ管理により、頻繁にアクセスされるファイルシステム操作を高速化
   *
   * 技術的詳細:
   * - LRUアルゴリズム: 最近使用されたエントリを優先保持
   * - メモリ制限: 最大エントリ数によるメモリ使用量制御
   * - TTL管理: 期限切れエントリの自動削除
   * - 分離設計: ディレクトリリストとファイル統計を独立管理
   */
  const dirCache = new LRUCache({
    max: 10000, // 最大10,000エントリ（ディレクトリリスト）- 大量画像フォルダでのメモリ不足を防ぐため削減
    ttl: DIR_TTL, // TTL: 1時間
    updateAgeOnGet: true, // 取得時にageを更新
  });

  const statCache = new LRUCache({
    max: 50000, // 最大50,000エントリ（ファイル統計情報）- 大量画像フォルダでのメモリ不足を防ぐため大幅削減
    ttl: STAT_TTL, // TTL: 1時間
    updateAgeOnGet: true, // 取得時にageを更新
  });

  // スタック処理システムでは並列処理制限は不要（順次処理のため）

  /**
   * ファイルシステム関数のキャッシュラッパー作成
   * 各サーバーインスタンスごとに独立したキャッシュを持つため、元の関数を保存
   */
  const origReaddirSync = fs.readdirSync; // 元のreaddirSyncを保存
  const origStatSync = fs.statSync; // 元のstatSyncを保存
  const origReaddirP = fs.promises.readdir.bind(fs.promises); // 元のreaddirを保存
  const origStatP = fs.promises.stat.bind(fs.promises); // 元のstatを保存

  /**
   * readdirSync（同期）のキャッシュラッパー
   * ディレクトリリスト取得をキャッシュ化し、大量のファイルがあるディレクトリでのパフォーマンスを向上
   *
   * @param {string} dir - ディレクトリパス
   * @param {Object} opts - オプション（{withFileTypes: true}など）
   * @returns {string[]} ディレクトリ内のファイル名配列（MAX_LIST件まで）
   *
   * 処理フロー:
   * 1. キャッシュから取得を試行
   * 2. キャッシュミスの場合、opendirSyncでストリーミング読み込み（メモリ効率化）
   * 3. エラー時は従来のreaddirSyncにフォールバック
   * 4. 結果をキャッシュに保存
   */
  function readdirSyncWrap(dir, opts) {
    // キャッシュチェック（LRUCacheのTTLが有効なら自動的に期限切れを判定）
    const cached = dirCache.get(dir); // キャッシュから取得
    if (cached) return cached.slice(0, getMaxList()); // キャッシュヒット時はMAX_LIST件まで返す

    let names = []; // ファイル名配列
    try {
      // opendirSyncを使用したストリーミング読み込み（大量ファイル対応）
      const dirHandle = fs.opendirSync(dir); // 同期opendir（Dirオブジェクトを返す）
      let entry; // Dirオブジェクトのエントリ
      // MAX_LIST件まで読み込み（メモリ使用量制限）
      while (
        (entry = dirHandle.readSync()) !== null &&
        names.length < getMaxList()
      ) {
        names.push(entry.name); // ファイル名を配列に追加
      }
      dirHandle.closeSync(); // Dirオブジェクトをクローズ
    } catch { // エラー時は従来のreaddirSyncにフォールバック
      names = origReaddirSync(dir, opts).slice(0, getMaxList()); // MAX_LIST件までに制限
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {} // キャッシュ保存エラーは無視

    return names; // ディレクトリ内のファイル名配列を返す
  }

  /**
   * statSync（同期）のキャッシュラッパー
   * ファイル統計情報取得をキャッシュ化し、頻繁なファイルアクセスを高速化
   *
   * @param {string} p - ファイル/ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Object} ファイル統計情報オブジェクト
   */
  function statSyncWrap(p, opts) {
    const cached = statCache.get(p); // キャッシュから取得
    if (cached) return cached; // キャッシュヒット時はそのまま返す

    try {
      const stat = origStatSync(p, opts); // 元のstatSyncを呼び出し
      // キャッシュ保存（エラーは無視）
      try {
        statCache.set(p, stat); // キャッシュに保存
      } catch (e) {} // キャッシュ保存エラーは無視
      return stat; // ファイル統計情報を返す
    } catch {
      // ファイルが存在しない場合のデフォルトオブジェクト
      return {
        isFile: () => false, // ファイルではない
        isDirectory: () => false, // ディレクトリではない
        mtimeMs: 0, // 最終更新時刻
        size: 0, // サイズ
      }; // ファイルが存在しない場合のデフォルトオブジェクトを返す
    }
  }

  /**
   * readdir（非同期）のキャッシュラッパー
   * 非同期ディレクトリリスト取得をキャッシュ化
   *
   * @param {string} dir - ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Promise<string[]>} ディレクトリ内のファイル名配列
   */
  async function readdirPWrap(dir, opts) {
    const cached = dirCache.get(dir); // キャッシュから取得
    if (cached) return cached.slice(0, getMaxList()); // キャッシュヒット時はMAX_LIST件まで返す

    let names = [];
    try {
      // 非同期opendirを使用したストリーミング読み込み
      const dirHandle = await fs.promises.opendir(dir); // 非同期opendir
      for await (const entry of dirHandle) {
        names.push(entry.name); // ファイル名を配列に追加
        if (names.length >= getMaxList()) break; // MAX_LIST件に達したら終了
      }
      await dirHandle.close();
    } catch { // エラー時は従来のreaddirにフォールバック
      names = await origReaddirP(dir, opts); // 非同期readdirにフォールバック
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {} // キャッシュ保存エラーは無視

    return names; // ディレクトリ内のファイル名配列を返す
  }

  /**
   * stat（非同期）のキャッシュラッパー
   * 非同期ファイル統計情報取得をキャッシュ化
   *
   * @param {string} p - ファイル/ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Promise<Object>} ファイル統計情報オブジェクト
   */
  async function statPWrap(p, opts) {
    const cached = statCache.get(p); // キャッシュから取得
    if (cached) return cached; // キャッシュヒット時はそのまま返す

    try {
      const stat = await origStatP(p, opts); // 元のstatを呼び出し
      // キャッシュ保存（エラーは無視）
      try {
        statCache.set(p, stat); // キャッシュに保存
      } catch (e) {}
      return stat; // ファイル統計情報を返す
    } catch {
      // ファイルが存在しない場合のデフォルトオブジェクト
      return {
        isFile: () => false, // ファイルではない
        isDirectory: () => false, // ディレクトリではない
        mtimeMs: 0, // 最終更新時刻
        size: 0, // サイズ
      };
    }
  }

  /**
   * WebDAVサーバーインスタンスの作成
   * RFC4918準拠のWebDAVプロトコルを実装
   *
   * 技術的詳細:
   * - RFC4918準拠: HTTP拡張としてのWebDAVプロトコル実装
   * - 認証なし: 同一ネットワーク内での使用を前提とした簡易設定
   * - シリアライザー: カスタムシリアライザーは使用せず、標準実装を利用
   */
  const server = new webdav.WebDAVServer({
    requireAuthentification: false, // 認証なし（パブリックアクセス）
    autoLoad: { serializers: [] }, // カスタムシリアライザーは使用しない
  });

  /**
   * WebDAVリクエストの前処理ミドルウェア
   * セキュリティ向上のため、Depth: infinityのPROPFINDリクエストを拒否
   * 無限階層のディレクトリ探索を防ぎ、サーバー負荷を軽減
   *
   * 技術的詳細:
   * - PROPFIND: WebDAVのプロパティ取得リクエスト
   * - Depth: infinity: 全サブディレクトリの再帰的探索（危険）
   * - セキュリティ対策: DoS攻撃や意図しない負荷増加を防止
   */
  server.beforeRequest((ctx, next) => {
    if (ctx.request.method === "PROPFIND") {
      const depthHeader = ctx.request.headers["depth"]; // Depthヘッダー取得
      const depth =
        (Array.isArray(depthHeader) ? depthHeader[0] : depthHeader) || "1"; // デフォルトは"1"

      if (depth.toLowerCase() === "infinity") {
        ctx.setCode(403); // 403 Forbiddenを設定
        return ctx.response.end("Depth infinity is not supported."); // エラーメッセージを返す
      }
    }
    next(); // 次のミドルウェアに処理を委譲
  });

  /**
   * キャッシュ機能付きWebDAVファイルシステムクラス
   * webdav-serverのPhysicalFileSystemを拡張し、ディレクトリリストとファイル統計情報をキャッシュ化
   * 大量のファイルがあるディレクトリでのWebDAV操作を高速化
   */
  class CachedFileSystem extends webdav.PhysicalFileSystem {
    /**
     * コンストラクタ
     * @param {string} rootPath - WebDAVのルートディレクトリパス
     * @param {LRUCache} dirCache - ディレクトリリストキャッシュ
     * @param {LRUCache} statCache - ファイル統計情報キャッシュ
     */
    constructor(rootPath, dirCache, statCache) { // コンストラクタ
      super(rootPath); // 親クラスのコンストラクタを呼び出し
      this.dirCache = dirCache; // ディレクトリリストキャッシュ
      this.statCache = statCache; // ファイル統計情報キャッシュ
    }

    /**
     * ディレクトリ読み込みのキャッシュ化オーバーライド
     * WebDAVのPROPFINDリクエストでディレクトリリストを取得する際にキャッシュを活用
     *
     * @param {string} path - ディレクトリパス
     * @param {Object} ctx - WebDAVコンテキスト
     * @param {Function} callback - コールバック関数
     */
    _readdir(path, ctx, callback) {
      try {
        const cached = this.dirCache.get(path); // キャッシュから取得
        if (cached) return callback(null, cached.slice(0, getMaxList())); // キャッシュヒット時はMAX_LIST件まで返す
      } catch (e) {
        // キャッシュエラー時は親クラスの実装にフォールバック
      }

      // 親クラスの_readdirを呼び出し
      super._readdir(path, ctx, (err, names) => {
        if (!err && Array.isArray(names)) { // エラーがなく配列の場合
          try {
            const limited = names.slice(0, getMaxList()); // MAX_LIST件までに制限
            this.dirCache.set(path, limited); // キャッシュに保存
            return callback(null, limited); // 制限後の配列を返す
          } catch (e) { // キャッシュ保存エラーの場合
            // キャッシュ保存エラーは無視
          }
        } // エラーがなく配列の場合はMAX_LIST件までに制限
        callback(err, names); // エラーまたはキャッシュ保存失敗時はそのまま返す
      }); // 親クラスの_readdirを呼び出し
    }

    /**
     * ファイル統計情報取得のキャッシュ化オーバーライド
     * WebDAVのPROPFINDリクエストでファイル情報を取得する際にキャッシュを活用
     *
     * @param {string} path - ファイル/ディレクトリパス
     * @param {Object} ctx - WebDAVコンテキスト
     * @param {Function} callback - コールバック関数
     */
    _stat(path, ctx, callback) {
      try {
        const cached = this.statCache.get(path); // キャッシュから取得
        if (cached) return callback(null, cached); // キャッシュヒット時はそのまま返す
      } catch (e) {
        // キャッシュエラー時は親クラスの実装にフォールバック
      }

      // 親クラスの_statを呼び出し
      super._stat(path, ctx, (err, stat) => {
        if (!err && stat) {
          try {
            this.statCache.set(path, stat); // キャッシュに保存
          } catch (e) {
            // キャッシュ保存エラーは無視
          }
        }
        callback(err, stat); // エラーまたはキャッシュ保存失敗時はそのまま返す
      });
    }
  }

  /**
   * WebDAVサーバーのファイルシステムマウント
   * キャッシュ機能付きファイルシステムをルートパス"/"にマウントし、HTTP/WebDAVハンドラを初期化する
   *
   * 注意: ここでfsの同期/非同期関数をラップしてプロセス内でキャッシュを使うように差し替える
   * 他モジュールも同じprocessのfsを参照するため副作用が発生する可能性がある
   */
  server.setFileSystem(
    "/",
    new CachedFileSystem(ROOT_PATH, dirCache, statCache),
    (success) => {
      if (!success) {
        logger.error(`マウント失敗`);
        process.exit(1);
      }

      /**
       * HTTPサーバー関連の初期化
       * fsのラッパーをインストールして、画像変換のin-flight管理等を用意
       * グローバルなfs関数をキャッシュ機能付きのラッパーに置き換える
       */
      try {
        fs.readdirSync = readdirSyncWrap;
        fs.statSync = statSyncWrap;
        fs.promises.readdir = readdirPWrap;
        fs.promises.stat = statPWrap;
      } catch (e) {
        logger.warn("[warn] failed to install fs wrappers", e);
      }

      // スタック処理システムでは複雑なin-flight管理は不要（順次処理のため）

      /**
       * セキュアなパス解決関数
       * パストラバーサル攻撃を防ぎ、指定されたルートディレクトリ内のパスのみアクセスを許可
       *
       * @param {string} root - ルートディレクトリパス
       * @param {string} urlPath - URLから取得したパス
       * @returns {string} 解決された安全なパス
       * @throws {Error} アクセスが拒否された場合
       *
       * 技術的詳細:
       * - パストラバーサル対策: "../"等の危険なパス要素を検出
       * - プラットフォーム対応: Windows/Unix系のパス区切り文字に対応
       * - 大文字小文字: Windowsでは大文字小文字を区別しない比較
       * - 正規化: path.resolveによる絶対パス化と正規化
       */
      const safeResolve = (root, urlPath) => {
        const decoded = decodeURIComponent(urlPath || ""); // URLデコード
        // クエリパラメータを削除して先頭のスラッシュを削除
        const rel = decoded.split("?")[0].replace(/^\/+/, ""); // 相対パス部分
        const candidate = path.resolve(root, rel); // 相対パスを絶対パスに解決
        const rootResolved = path.resolve(root); // ルートパスを絶対パスに解決

        // プラットフォームによって異なるパス比較（Windowsは大文字小文字を区別しない）
        if (process.platform === "win32") {
          const lc = candidate.toLowerCase(); // 小文字化
          const rr = rootResolved.toLowerCase(); // 小文字化
          if (!(lc === rr || lc.startsWith(rr + path.sep)))
            throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
        } else {
          if (
            !(
              candidate === rootResolved ||
              candidate.startsWith(rootResolved + path.sep)
            )
          )
            throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
        }
        return candidate; // 安全なパスを返す
      };

      /**
       * Content-Type判定関数
       * ファイル拡張子に基づいて適切なMIMEタイプを返す
       *
       * @param {string} ext - ファイル拡張子
       * @returns {string} MIMEタイプ
       */
      const getContentType = (ext) => {
        const contentTypes = { // MIMEタイプ
          ".html": "text/html; charset=utf-8", // HTMLファイル
          ".htm": "text/html; charset=utf-8", // HTMLファイル
          ".css": "text/css; charset=utf-8", // CSSファイル
          ".js": "application/javascript; charset=utf-8", // JavaScriptファイル
          ".json": "application/json; charset=utf-8", // JSONファイル
          ".xml": "application/xml; charset=utf-8", // XMLファイル
          ".txt": "text/plain; charset=utf-8", // テキストファイル
          ".md": "text/markdown; charset=utf-8", // Markdownファイル
        };
        return contentTypes[ext.toLowerCase()] || "application/octet-stream"; // MIMEタイプを返す
      };

      /**
       * HTTPサーバーの作成
       * 画像変換機能付きのHTTPサーバーを起動し、WebDAVリクエストと画像変換リクエストを処理
       *
       * 技術的詳細:
       * - ハイブリッド処理: WebDAVと画像変換の両方を単一サーバーで処理
       * - 拡張子判定: 画像ファイルの自動検出と変換処理の分岐
       * - ストリーミング: 大容量ファイルの効率的な転送
       * - エラーハンドリング: 各処理段階での適切なエラー応答
       */
      const httpServer = http.createServer(async (req, res) => {
        // EventEmitterメモリリーク防止
        res.setMaxListeners(20); // 最大リスナー数を20に設定

        // シンプルな監視開始
        const requestId = Date.now(); // 簡単なリクエストID

        // IPアドレス取得
        const clientIP =
          req.connection.remoteAddress || // IPアドレス
          req.socket.remoteAddress || // IPアドレス
          (req.connection.socket
            ? req.connection.socket.remoteAddress // IPアドレス
            : null) ||
          req.headers["x-forwarded-for"]?.split(",")[0] || // IPアドレス
          "unknown";

        const urlPath = req.url.split("?")[0]; // クエリパラメータを削除
        // v20 と同様に decodeURIComponent を使って表示用パスを作成
        const displayPath = decodeURIComponent(urlPath); // URLデコード
        const ext = path.extname(displayPath).toLowerCase(); // 拡張子を小文字化
        let fullPath; // フルパス

        // --- 設定UIエンドポイント: /setting を提供 ---
        // 目的: config.txt の内容を閲覧・編集する簡易UIを提供する
        try {
          const SETTING_PREFIX = "/setting"; // 設定UIのプレフィックス
          const cfgPath = path.join(__dirname, "..", "config.txt"); // 設定ファイルのパス

          if (
            urlPath === "/setting" || // "setting"の場合
            urlPath.startsWith(SETTING_PREFIX + "/") || // "setting/"から始まる場合
            urlPath === SETTING_PREFIX // "setting"の場合
          ) {
            const publicDir = path.join(__dirname, "..", "public"); // パスを結合
            const cfgPath = path.join(__dirname, "..", "config.txt"); // パスを結合

            // GET /setting/sysinfo -> システム情報を含むJSON（APIエンドポイントを先に処理）
            if (
              req.method === "GET" && // GETメソッドの場合
              (urlPath === "/setting/sysinfo" || urlPath === "/setting/sysinfo/") // "setting/sysinfo"または"setting/sysinfo/"の場合
            ) {
              try {
                const cpuCount = os.cpus().length;
                const totalMemory = os.totalmem();
                const totalMemoryGB = Math.round((totalMemory / (1024 * 1024 * 1024)) * 10) / 10;
                const recommendedConcurrency = Math.max(4, Math.min(cpuCount, 32));
                const recommendedMemory = Math.max(256, Math.min(Math.floor(totalMemoryGB * 1024 * 0.25), 8192));
                
                const sysInfo = {
                  cpuCount,
                  totalMemoryGB,
                  recommendedConcurrency,
                  recommendedMemory,
                  maxConcurrency: 32 // 最大並列数の制限
                };
                
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify(sysInfo));
              } catch (e) {
                logger.warn("[sysinfo error]", e);
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ error: "sysinfo_error" }));
              }
            }

            // GET /setting/stats -> 統計情報
            if (
              req.method === "GET" &&
              (urlPath === "/setting/stats" || urlPath === "/setting/stats/")
            ) {
              try {
                const snapshot = getStatsSnapshot();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify(snapshot));
              } catch (e) {
                logger.warn("[stats endpoint error]", e);
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                return res.end(JSON.stringify({ error: "stats_error" }));
              }
            }

            // public/settings.htmlからメインUIを提供
            if (
              req.method === "GET" && // GETメソッドの場合
              (urlPath === "/setting" || urlPath === "/setting/") // "setting"または"setting/"の場合
            ) {
              const filePath = path.join(publicDir, "settings.html"); // パスを結合
              try {
                const data = await fs.promises.readFile(filePath, "utf8"); // ファイルデータを読み込む
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); // コンテントタイプを設定
                return res.end(data); // ファイルデータを送信
              } catch (e) { // ファイル読み込みエラーの場合
                logger.warn("[setting UI serve error]", e); // エラーログ
                res.writeHead(500); // ステータスコードを500に設定
                return res.end("Unable to load settings UI"); // 設定UIを読み込めない場合はUnable to load settings UIを送信
              }
            }

            // /setting/<path>下の静的ファイルを提供（APIパスを除く）
            if (
              req.method === "GET" && // GETメソッドの場合
              urlPath.startsWith(SETTING_PREFIX + "/") && // "setting/"から始まる場合
              !urlPath.startsWith(SETTING_PREFIX + "/data") && // "setting/data"から始まる場合
              !urlPath.startsWith(SETTING_PREFIX + "/save") // "setting/save"から始まる場合
            ) {
              const rel = urlPath.slice(SETTING_PREFIX.length + 1); // "setting/"を削除
              const filePath = path.join(publicDir, rel); // パスを結合
              try {
                const ext = path.extname(filePath); // ファイル拡張子を取得
                // テキストファイル（.js, .css, .html等）はUTF-8エンコーディングで読み込む
                const isTextFile = ['.js', '.css', '.html', '.htm', '.txt', '.json', '.svg', '.xml'].includes(ext.toLowerCase());
                let data;
                if (isTextFile) {
                  // テキストファイルはUTF-8で読み込んで、明示的にBufferに変換して送信
                  const text = await fs.promises.readFile(filePath, "utf8");
                  data = Buffer.from(text, "utf8");
                } else {
                  // バイナリファイルはそのまま読み込む
                  data = await fs.promises.readFile(filePath);
                }
                const contentType = getContentType(ext); // コンテントタイプ
                res.writeHead(200, { "Content-Type": contentType }); // コンテントタイプを設定
                return res.end(data); // ファイルデータを送信
              } catch (e) { // ファイル読み込みエラーの場合
                res.writeHead(404); // ステータスコードを404に設定
                return res.end("Not found"); // ファイルが見つからない場合はNot foundを送信
              }
            }

            // GET /setting/data -> 設定内容を含むJSON
            if (
              req.method === "GET" && // GETメソッドの場合
              (urlPath === "/setting/data" || urlPath === "/setting/data/") // "setting/data"または"setting/data/"の場合
            ) {
              try {
                const txt = await fs.promises
                  .readFile(cfgPath, "utf8") // 設定ファイルを読み込む
                  .catch(() => ""); // 設定ファイルが存在しない場合は空文字列を返す
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); // コンテントタイプを設定
                return res.end(JSON.stringify({ content: txt })); // 設定内容を送信
              } catch (e) { // 設定ファイル読み込みエラーの場合
                logger.warn("[setting read error]", e); // エラーログ
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }); // コンテントタイプを設定
                return res.end(JSON.stringify({ error: "read_error" })); // 設定内容を送信
              }
            }

            // POST /setting/save -> 設定内容を書き込み（JSON { content: "..." }を期待）
            if (
              req.method === "POST" && // POSTメソッドの場合
              (urlPath === "/setting/save" || urlPath === "/setting/save/") // "setting/save"または"setting/save/"の場合
            ) {
              let body = ""; // ボディ
              req.on("data", (chunk) => { // データを受信
                body += chunk.toString(); // ボディを追加
                // 制限: 大きすぎるボディは切断
                if (body.length > 1e6) { // ボディが1MBを超える場合
                  res.writeHead(413); // ステータスコードを413に設定
                  res.end("Payload too large"); // ペイロードが大きすぎる場合はPayload too largeを送信
                  req.connection.destroy(); // 接続を破棄
                }
              }); // データを受信
              req.on("end", async () => { // データを受信完了
                try {
                  const obj = JSON.parse(body || "{}"); // ボディをJSONパース
                  if (typeof obj.content !== "string") {
                    res.writeHead(400); // ステータスコードを400に設定
                    return res.end("Bad request"); // リクエストが不正な場合はBad requestを送信
                  }
                  // 既存の設定を.backupディレクトリにバックアップ（ディレクトリの存在を確認）
                  // try {
                  //   const backupDir = path.join(__dirname, "..", ".backup");
                  //   // バックアップディレクトリが存在しない場合は作成（安全のため再帰的に）
                  //   await fs.promises
                  //     .mkdir(backupDir, { recursive: true })
                  //     .catch(() => {});
                  //   const bakPath = path.join(
                  //     backupDir,
                  //     "config.bak." + Date.now() + ".txt",
                  //   );
                  //   await fs.promises
                  //     .copyFile(cfgPath, bakPath)
                  //     .catch(() => {});
                  // } catch (e) {
                  //   // バックアップエラーは無視
                  // }
                  // 安全のため、必ず UTF-8 で書き込む
                  await fs.promises.writeFile(cfgPath, obj.content, "utf8"); // 設定ファイルを書き込む
                  logger.info("[設定保存] config.txt が更新されました"); // 設定保存ログ
                  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); // コンテントタイプを設定
                  return res.end("OK"); // OKを送信
                } catch (e) { // 設定保存エラーの場合
                  logger.error("[setting save error]", e); // エラーログ
                  res.writeHead(500); // ステータスコードを500に設定
                  return res.end("Internal error"); // 内部エラーの場合はInternal errorを送信
                }
              });
              return; // 設定保存完了
            }

            // 未対応の /setting パスは 404
            res.writeHead(404); // ステータスコードを404に設定
            return res.end("Not found"); // ファイルが見つからない場合はNot foundを送信
          }
        } catch (e) {
          logger.warn("[setting ui handler error]", e); // 設定UIハンドラーエラーログ
          // 続行して通常の処理にフォールバック
        }

        try {
          fullPath = safeResolve(ROOT_PATH, urlPath); // パスを解決
        } catch (e) {
          res.writeHead(403); // ステータスコードを403に設定
          return res.end("Access denied"); // アクセスが拒否された場合はAccess deniedを送信
        }

        // PROPFINDリクエストの詳細ログ出力
        if (req.method === "PROPFIND") {
          let depth = req.headers["depth"]; // depthヘッダーを取得
          if (Array.isArray(depth)) depth = depth[0]; // depthが配列の場合は最初の要素を取得
          if (depth === undefined) depth = "(none)"; // depthが未定義の場合は"(none)"を設定
          logger.info(`[PROPFIND] from=${req.connection.remoteAddress} path=${displayPath} depth=${depth}`); // PROPFINDログ
        }

        logger.info(`${req.connection.remoteAddress} ${req.method} ${displayPath}`); // リクエストログ

        /**
         * 画像ファイルのGETリクエスト処理（並列処理）
         * 画像拡張子を持つファイルへのアクセス時に変換処理を直接実行
         */
        if (req.method === "GET" && IMAGE_EXTS.includes(ext)) {
          logger.info(`[変換要求] ${fullPath}`); // 変換要求ログ

          // 並列制限付きで直接変換処理を実行（スタック処理は使用しない）
          (async () => {
            const st = await statPWrap(fullPath).catch(() => null);

            // ファイルが存在しない場合（ディレクトリやファイルでない場合）
            if (!st || !st.isFile()) {
              logger.warn(`[404 Not Found] ${fullPath}`); // 404 Not Foundログ
              res.writeHead(404); // ステータスコードを404に設定
              return res.end("Not found"); // ファイルが見つからない場合はNot foundを送信
            }

            const recordImageStats = (optimizedBytes, cacheHit = false) => {
              if (!st || typeof st.size !== "number" || st.size <= 0) return;
              const optimized =
                typeof optimizedBytes === "number" && optimizedBytes >= 0
                  ? optimizedBytes
                  : st.size;
              try {
                recordImageTransfer({
                  originalBytes: st.size,
                  optimizedBytes: optimized,
                  cacheHit,
                });
              } catch (_) {}
            };

            // 画像変換機能が無効の場合は元画像をそのまま返す
            if (!getImageConversionEnabled()) {
              logger.info(`[画像変換無効] 元画像をそのまま返します: ${fullPath}`);
              const fileExt = path.extname(fullPath).toLowerCase();
              let contentType = 'application/octet-stream';
              if (fileExt === '.jpg' || fileExt === '.jpeg') contentType = 'image/jpeg';
              else if (fileExt === '.png') contentType = 'image/png';
              else if (fileExt === '.gif') contentType = 'image/gif';
              else if (fileExt === '.webp') contentType = 'image/webp';
              else if (fileExt === '.bmp') contentType = 'image/bmp';
              else if (fileExt === '.tiff' || fileExt === '.tif') contentType = 'image/tiff';
              else if (fileExt === '.avif') contentType = 'image/avif';
              else if (fileExt === '.heic' || fileExt === '.heif') contentType = 'image/heic';

              res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": st.size,
                "Last-Modified": new Date(st.mtimeMs).toUTCString(),
                Connection: "Keep-Alive",
                "Keep-Alive": "timeout=600",
              });

              const fileStream = fs.createReadStream(fullPath);
              fileStream.pipe(res);
              fileStream.on("error", (err) => {
                logger.error(`[元画像送信失敗] ${displayPath}: ${err.message}`);
                if (!res.headersSent) res.writeHead(500);
                res.end("Failed to read original image");
              });
              fileStream.on("end", () => recordImageStats(st.size, false));
              return;
            }

            // 画像サイズが1MB以上の場合のみキャッシュ
            const shouldCache = st.size >= getCacheMinSize(); // キャッシュが必要かどうか

            /**
             * 品質パラメータの取得と検証
             * クエリパラメータから品質を取得し、30-90の範囲に制限
             * 設定ファイルから動的にデフォルト品質を取得
             */
            const qParam = req.url.match(/[?&]q=(\d+)/)?.[1]; // 品質パラメータを取得
            const quality = qParam // 品質パラメータが存在する場合は品質パラメータを取得
              ? Math.min(Math.max(parseInt(qParam, 10), 30), 90) // 品質パラメータを30-90の範囲に制限
              : getDefaultQuality(); // デフォルト品質を取得して品質パラメータを設定

            /**
             * キャッシュキーの生成
             * ファイルパス、リサイズサイズ、品質、変更時間、ファイルサイズを含めて
             * ファイルの変更を検知し、適切なキャッシュ管理を実現
             * SHA-256ハッシュを使用して固定長のキーを生成（Windowsパス長制限対策）
             */
            const keyData = fullPath +
              "|" +
              (getPhotoSize() ?? "o") + // 写真サイズを取得
              "|" +
              quality + // 品質を取得
              "|" +
              String(st.mtimeMs) + // ファイルの変更時間を取得
              "|" +
              String(st.size); // ファイルサイズを取得
            
            // SHA-256ハッシュを使用して64文字の固定長キーを生成
            const key = crypto.createHash('sha256').update(keyData, 'utf8').digest('hex');
            const cachePath = activeCacheDir // キャッシュディレクトリが存在する場合はキャッシュパスを設定
              ? path.join(activeCacheDir, key + ".webp") // キャッシュパスを設定
              : null; // キャッシュディレクトリが存在しない場合はnullを設定

            /**
             * キャッシュファイルの存在確認とレスポンス
             * 非同期でチェックしてブロッキングを避ける
             */
            if (shouldCache) {
              try {
                const cst = await statPWrap(cachePath).catch(() => null);
                if (cst && cst.isFile && cst.isFile()) {
                  // キャッシュファイルが存在する場合、直接レスポンス
                  const headers = {
                    "Content-Type": "image/webp", // コンテントタイプを設定
                    "Content-Length": cst.size, // コンテント長を設定
                    "Last-Modified": new Date(cst.mtimeMs).toUTCString(), // 最終更新時間を設定
                    ETag: '"' + cst.size + "-" + Number(cst.mtimeMs) + '"', // ETagを設定
                    Connection: "Keep-Alive", // 接続を保持
                    "Keep-Alive": "timeout=600", // 接続タイムアウトを600秒に設定
                  }; // ヘッダーを設定
                  res.writeHead(200, headers); // ステータスコードを200に設定してヘッダーを送信
                  try {
                    const s = fs.createReadStream(cachePath);
                    let recorded = false;
                    const recordOnce = () => {
                      if (recorded) return;
                      recorded = true;
                      recordImageStats(cst.size, true);
                    };
                    const onErr = (e) => {
                      logger.warn("[cache stream error]", e);
                      try { if (!res.headersSent) res.writeHead(500); } catch(_) {}
                      try { res.end("Internal error"); } catch(_) {}
                    };
                    s.on('error', onErr);
                    s.on('end', recordOnce);
                    res.on('close', () => { try { s.destroy(); } catch(_) {} });
                    return s.pipe(res);
                  } catch (e) {
                    logger.warn("[cache stream open error]", e);
                    try { if (!res.headersSent) res.writeHead(500); } catch(_) {}
                    return res.end("Internal error");
                  }
                }
              } catch (e) {
                logger.warn("[cache read error async]", e); // キャッシュ読み込みエラーは警告ログを出力
              }
            }

            // 画像変換を実行（並列制限付き）
            try {
              await convertAndRespondWithLimit({
                fullPath, // ファイルパス
                displayPath, // 表示パス
                cachePath: shouldCache ? cachePath : null, // キャッシュパス
                quality, // 品質
                Photo_Size: getPhotoSize(), // 写真サイズ
                res, // レスポンス
                clientIP, // クライアントIP
                originalSize: st.size,
              }); // 画像変換を実行
            } catch (e) {
              logger.warn("[convert error]", e);
              try { res.writeHead(500); res.end('Internal error'); } catch (_) {}
            }
          })().catch((e) => {
            logger.warn('[async convert handler error]', e);
            try { if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); } } catch (_) {}
          }); // 即座に非同期関数を実行

          return; // 非同期処理なので即座にレスポンスを返さない
        }

        /**
         * WebDAVリクエストの処理
         * 画像以外のファイルやディレクトリに対するWebDAV操作を処理
         */
        try {
          logger.info(`[WebDAV] ${req.method} ${displayPath}`); // WebDAVリクエストログ

          // レスポンスオブジェクトの型チェック（WebDAVサーバーとの互換性確保）
          if (typeof res.setHeader === "function") {
            res.setHeader("Connection", "Keep-Alive"); // 接続を保持
            res.setHeader("Keep-Alive", "timeout=120"); // 接続タイムアウトを120秒に設定
            res.setHeader("Accept-Ranges", "bytes"); // バイト単位での範囲リクエストを許可
            res.setHeader(
              "Cache-Control", // キャッシュコントロールヘッダーを設定
              "public, max-age=0, must-revalidate", // キャッシュを有効にして最大キャッシュ時間を0秒に設定し、必ず再検証を要求
            ); // キャッシュコントロールヘッダーを設定
          }

          // WebDAVレスポンスの圧縮処理
          if (getCompressionEnabled() && typeof res.setHeader === "function") { // 圧縮が有効かどうか
            const acceptEncoding = req.headers["accept-encoding"] || ""; // accept-encodingヘッダーを取得
            const supportsGzip = acceptEncoding.includes("gzip"); // gzipがサポートされているかどうか

            if (supportsGzip) { // gzipがサポートされている場合
              // レスポンスのラッパーを作成して圧縮処理を追加
              const originalWriteHead = res.writeHead; // レスポンスのwriteHeadメソッド
              const originalWrite = res.write; // レスポンスのwriteメソッド
              const originalEnd = res.end; // レスポンスのendメソッド

              let responseData = []; // レスポンスデータ
              let headersWritten = false; // ヘッダーが書き込まれたかどうか

              res.writeHead = function (statusCode, statusMessage, headers) { // レスポンスのwriteHeadメソッド
                if (typeof statusCode === "object") { // ステータスコードがオブジェクトの場合
                  headers = statusCode; // ヘッダーをステータスコードに設定
                  statusCode = 200; // ステータスコードを200に設定
                } // ステータスコードがオブジェクトの場合はヘッダーをステータスコードに設定
                headers = headers || {}; // ヘッダーを空のオブジェクトに設定

                // Content-Typeを確認（画像ファイルは除外）
                const contentType =
                  headers["content-type"] || // content-typeヘッダーを取得
                  res.getHeader("content-type") || // content-typeヘッダーを取得
                  ""; // content-typeヘッダーが存在しない場合は空文字列を設定
                const isTextResponse =
                  contentType.includes("xml") || // xmlが含まれているかどうか
                  contentType.includes("html") || // htmlが含まれているかどうか
                  contentType.includes("json") || // jsonが含まれているかどうか
                  contentType.includes("text"); // textが含まれているかどうか

                // 画像ファイルは圧縮対象から除外
                const isImageResponse =
                  contentType.includes("image/") || // image/が含まれているかどうか
                  contentType.includes("video/") || // video/が含まれているかどうか
                  contentType.includes("audio/") || // audio/が含まれているかどうか
                  contentType.includes("application/octet-stream"); // application/octet-streamが含まれているかどうか

                if (isTextResponse && !isImageResponse) { // テキストレスポンスで画像ファイル以外の場合
                  // テキストレスポンスで画像ファイル以外の場合は圧縮準備
                  headers["Vary"] = "Accept-Encoding"; // Varyヘッダーを設定
                }

                headersWritten = true; // ヘッダーが書き込まれたことを設定
                return originalWriteHead.call(
                  this, // レスポンスオブジェクト
                  statusCode, // ステータスコード
                  statusMessage, // ステータスメッセージ
                  headers, // ヘッダー
                ); // レスポンスのwriteHeadメソッド
              };

              res.write = function (chunk, encoding) { // レスポンスのwriteメソッド
                if (chunk) { // チャンクが存在する場合
                  responseData.push( // レスポンスデータにチャンクを追加
                    Buffer.isBuffer(chunk) // チャンクがバッファの場合
                      ? chunk // チャンクをそのまま追加
                      : Buffer.from(chunk, encoding || "utf8"), // チャンクを文字列に変換して追加
                  );
                } // チャンクが存在する場合はレスポンスデータにチャンクを追加
                return true; // 成功を返す
              }; // レスポンスのwriteメソッド

              res.end = function (chunk, encoding) { // レスポンスのendメソッド
                // 既にレスポンスが終了している場合は何もしない
                if (res.headersSent && res.finished) { // 既にレスポンスが終了している場合
                  return; // 何もしない
                } // 既にレスポンスが終了している場合は何もしない

                if (chunk) { // チャンクが存在する場合
                  responseData.push( // レスポンスデータにチャンクを追加
                    Buffer.isBuffer(chunk) // チャンクがバッファの場合
                      ? chunk // チャンクをそのまま追加
                      : Buffer.from(chunk, encoding || "utf8"), // チャンクを文字列に変換して追加
                  );
                } // チャンクが存在する場合はレスポンスデータにチャンクを追加

                if (responseData.length === 0) { // レスポンスデータが空の場合
                  return originalEnd.call(this); // レスポンスのendメソッドを呼び出す
                } // レスポンスデータが空の場合はレスポンスのendメソッドを呼び出す

                const fullData = Buffer.concat(responseData); // レスポンスデータをバッファに結合
                const contentType = res.getHeader("content-type") || ""; // コンテントタイプを取得
                const isTextResponse =
                  contentType.includes("xml") || // xmlが含まれているかどうか
                  contentType.includes("html") || // htmlが含まれているかどうか
                  contentType.includes("json") || // jsonが含まれているかどうか
                  contentType.includes("text"); // textが含まれているかどうか

                // 画像ファイルは圧縮対象から除外
                const isImageResponse =
                  contentType.includes("image/") || // image/が含まれているかどうか
                  contentType.includes("video/") || // video/が含まれているかどうか
                  contentType.includes("audio/") || // audio/が含まれているかどうか
                  contentType.includes("application/octet-stream"); // application/octet-streamが含まれているかどうか

                // 最小サイズ制限（1KB未満は圧縮しない）
                const MIN_COMPRESS_SIZE = 1024; // 最小サイズ制限（1KB未満は圧縮しない）
                if (!isTextResponse || isImageResponse || fullData.length < MIN_COMPRESS_SIZE) { // テキストレスポンスで画像ファイル以外の場合は圧縮スキップ
                  logger.info(`[圧縮スキップ] ${displayPath} - 条件未満: テキスト=${isTextResponse}, 画像=${isImageResponse}, サイズ=${fullData.length}`); // 圧縮スキップログ
                  return originalEnd.call(this, fullData); // レスポンスのendメソッドを呼び出す
                } // テキストレスポンスで画像ファイル以外の場合は圧縮スキップ

                // 圧縮処理
                zlib.gzip(
                  fullData, // 圧縮対象データ
                  {
                    level: 9, // 圧縮レベル
                    memLevel: 9, // メモリレベル
                    windowBits: 15, // ウィンドウビット
                  },
                  (err, compressed) => { // 圧縮処理
                    if (res.headersSent && res.finished) return; // レスポンスが既に終了している場合は何もしない

                    if (err) { // 圧縮エラーの場合
                      logger.warn(`[圧縮エラー] ${displayPath}: ${err.message}`); // 圧縮エラーログ
                      return originalEnd.call(this, fullData); // レスポンスのendメソッドを呼び出す
                    } // 圧縮エラーの場合はレスポンスのendメソッドを呼び出す

                    // 圧縮効果の確認
                    const compressionRatio = compressed.length / fullData.length; // 圧縮率
                    const threshold = getCompressionThreshold(); // 圧縮閾値
                    logger.info(`[圧縮結果] ${displayPath} - 圧縮率: ${(compressionRatio * 100).toFixed(1)}%, 閾値: ${(threshold * 100).toFixed(1)}%`); // 圧縮結果ログ

                    if (compressionRatio < threshold) { // 圧縮率が閾値未満の場合
                      // 圧縮レスポンスの送信
                      res.setHeader("Content-Encoding", "gzip"); // コンテントエンコーディングをgzipに設定
                      res.setHeader("Content-Length", compressed.length); // コンテント長を設定
                      logger.info(`[圧縮適用] ${displayPath} サイズ: ${fullData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`); // 圧縮適用ログ
                      try {
                        recordTextCompression({
                          originalBytes: fullData.length,
                          optimizedBytes: compressed.length,
                        });
                      } catch (_) {}
                      originalEnd.call(this, compressed); // レスポンスのendメソッドを呼び出す
                    } else { // 圧縮率が閾値以上の場合
                      logger.info(`[圧縮スキップ] ${displayPath} - 圧縮効果が不十分: ${(compressionRatio * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(1)}%`); // 圧縮スキップログ
                      originalEnd.call(this, fullData); // レスポンスのendメソッドを呼び出す
                    } // 圧縮率が閾値以上の場合はレスポンスのendメソッドを呼び出す
                  },
                );
              }; // レスポンスのendメソッド
            } // gzipがサポートされている場合は圧縮処理を実行
          }

          // テキストファイルの圧縮処理（WebDAV処理の前）
          const textExts = [
            ".html", // HTMLファイル
            ".htm", // HTMLファイル
            ".css", // CSSファイル
            ".js", // JavaScriptファイル
            ".json", // JSONファイル
            ".xml", // XMLファイル
            ".txt", // テキストファイル
            ".md", // Markdownファイル
          ];
          const imageExts = [
            ".jpg", // JPEG画像
            ".jpeg", // JPEG画像
            ".png", // PNG画像
            ".gif", // GIF画像
            ".webp", // WebP画像
            ".bmp", // BMP画像
            ".tiff", // TIFF画像
            ".tif", // TIFF画像
            ".avif", // AVIF画像
            ".heic", // HEIC画像
            ".heif", // HEIF画像
            ".svg", // SVG画像
          ];
          const isTextFile = textExts.includes(ext.toLowerCase()); // テキストファイルかどうか
          const isImageFile = imageExts.includes(ext.toLowerCase()); // 画像ファイルかどうか

          if (
            getCompressionEnabled() && // 圧縮機能が有効の場合
            req.method === "GET" && // GETメソッドの場合
            isTextFile && // テキストファイルの場合
            !isImageFile && // 画像ファイルの場合
            typeof res.setHeader === "function" // setHeaderメソッドが存在する場合
          ) {
            // 圧縮対応の確認
            const acceptEncoding = req.headers["accept-encoding"] || ""; // accept-encodingヘッダーを取得
            const supportsGzip = acceptEncoding.includes("gzip"); // gzipがサポートされているかどうか

            if (supportsGzip) {
              try { // 圧縮処理のtry-catch
                // ファイルの存在確認
                const fileStat = await statPWrap(fullPath).catch(() => null); // ファイルの存在確認
                if (fileStat && fileStat.isFile() && fileStat.size > 1024) { // ファイルが存在し、ファイルサイズが1KB以上の場合
                  // 1KB以上の場合のみ圧縮
                  // ファイル読み込みと圧縮（高性能環境向け非同期処理）
                  const fileData = await fs.promises.readFile(fullPath); // ファイルデータを読み込む
                  const compressed = await new Promise((resolve, reject) => { // 圧縮処理のPromise
                    zlib.gzip(
                      fileData, // ファイルデータ
                      {
                        level: 9, // 圧縮レベル
                        memLevel: 9, // メモリレベル
                        windowBits: 15, // ウィンドウビット
                      }, // 圧縮オプション
                      (err, result) => {
                        if (err) reject(err); // 圧縮エラーの場合はreject
                        else resolve(result); // 圧縮後データの場合はresolve
                      }, // 圧縮エラー、圧縮後データ
                    ); // 圧縮処理
                  }); // 圧縮処理のPromise

                  // 圧縮効果の確認（環境変数で閾値を制御可能）
                  const compressionRatio = compressed.length / fileData.length; // 圧縮率
                  if (compressionRatio < getCompressionThreshold()) {
                    // 圧縮レスポンスの送信
                    res.writeHead(200, {
                      "Content-Type": getContentType(ext), // コンテントタイプ
                      "Content-Encoding": "gzip", // コンテントエンコーディング
                      "Content-Length": compressed.length, // コンテント長
                      Vary: "Accept-Encoding", // Varyヘッダー
                    });
                    res.end(compressed); // 圧縮後データを送信
                    try {
                      recordTextCompression({
                        originalBytes: fileData.length,
                        optimizedBytes: compressed.length,
                      });
                    } catch (_) {}
                    logger.info(`[ファイル圧縮完了] ${displayPath} サイズ: ${fileData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`); // 圧縮完了ログ
                    return; // 圧縮レスポンスを送信して処理終了
                  }
                }
              } catch (compressError) { // 圧縮エラーの場合
                logger.warn(`[ファイル圧縮エラー] ${displayPath}: ${compressError.message}`); // 圧縮エラーログ
              }
            }
          }

          server.executeRequest(req, res); // リクエストを実行
        } catch (e) {
          logger.error("WebDAV error", e); // WebDAVエラーログ
          if (!res.headersSent && typeof res.writeHead === "function") { // ヘッダーが書き込まれていない場合
            res.writeHead(500); // ステータスコードを500に設定
            res.end("WebDAV error"); // WebDAVエラーメッセージを送信
          } else if (typeof res.end === "function") { // endメソッドが存在する場合
            res.end(); // レスポンスを終了
          }
        } // エラーハンドリング
      });

      /**
       * HTTPサーバーのタイムアウト設定
       * 長時間の接続やリクエストによるリソース枯渇を防ぐ
       *
       * 技術的詳細:
       * - ソケットタイムアウト: 非アクティブ接続の自動切断
       * - Keep-Aliveタイムアウト: 接続再利用の最大時間
       * - ヘッダータイムアウト: リクエストヘッダー受信の最大時間
       * - リソース保護: メモリリークとファイルディスクリプタ枯渇の防止
       */
      httpServer.setTimeout(60000); // タイムアウト時間を60秒に設定
      httpServer.keepAliveTimeout = 60000; // Keep-Aliveタイムアウト時間を60秒に設定
      httpServer.headersTimeout = 65000; // ヘッダータイムアウト時間を65秒に設定

      /**
       * HTTPサーバーのエラーハンドリング
       * EADDRINUSE等のエラーでクラッシュしないようにエラーイベントを先に登録
       */
      httpServer.on("error", (err) => {
        if (err && err.code === "EADDRINUSE") { // ポートが既に使用されている場合
          logger.error(`ポート ${PORT} は既に使用されています。サーバーの起動をスキップします。`); // ポートが既に使用されている場合のエラーログ
        } else { // エラーの場合
          logger.error("HTTP server error", err); // HTTPサーバーエラーログ
        }
      });

      /**
       * HTTPサーバーの起動
       * 指定されたポートでサーバーを起動し、起動完了をログ出力
       */
      httpServer.listen(PORT, () => {
        logger.info(`✅ WebDAV 起動: http://localhost:${PORT}/`); // WebDAV起動ログ
        logger.info(`[INFO] キャッシュDir=${activeCacheDir || "無効"} / MAX_LIST=${getMaxList()} / Photo_Size=${getPhotoSize() ?? "オリジナル"}`); // キャッシュディレクトリログ
        logger.info(`[INFO] 圧縮機能=${getCompressionEnabled() ? "有効" : "無効"} / 圧縮閾値=${(getCompressionThreshold() * 100).toFixed(1)}%`); // 圧縮機能ログ
      });
    },
  );
}

module.exports = {
  startWebDAV, // WebDAVサーバー起動関数
};
