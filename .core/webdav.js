// === WebDAVサーバーシステムモジュール ===
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const stream = require("stream");
const { promisify } = require("util");
const { execFile, spawn } = require("child_process");
const zlib = require("zlib");

// 外部ライブラリ
const sharp = require("sharp");
const webdav = require("webdav-server").v2;
const pLimit = require("p-limit");
const { LRUCache } = require("lru-cache");

// 設定管理モジュール
const {
  logger,
  getDynamicConfig,
  getCompressionEnabled,
  getCompressionThreshold,
  getCacheMinSize,
  getCacheTTL,
  getServerPort,
  getServerRootPath,
} = require("./config");

// スタック処理モジュール
const { initializeStackSystem } = require("./stack");

// 画像変換モジュール
const { convertAndRespond, convertAndRespondWithLimit } = require("./image");

const PassThrough = stream.PassThrough;
const pipeline = promisify(stream.pipeline);

/**
 * WebDAVサーバー起動関数
 * config.txtの設定でWebDAVサーバーとHTTPサーバーを起動し、画像変換機能を提供
 *
 * @param {string|null} activeCacheDir - アクティブキャッシュディレクトリ
 */
function startWebDAV(activeCacheDir) {
  // config.txtから動的に設定を読み込み
  const PORT = getServerPort();
  const ROOT_PATH = getServerRootPath();

  // スタック処理システムの初期化（サーバーインスタンスごとに一度だけ）
  const { requestStack, serverMonitor } = initializeStackSystem();

  // 動的設定読み込み関数
  const getPhotoSize = () => getDynamicConfig("PHOTO_SIZE", 1024);
  const getMaxList = () => getDynamicConfig("MAX_LIST", 1280);
  const getDefaultQuality = () => getDynamicConfig("DEFAULT_QUALITY", 70);

  // 画像変換対象の拡張子リスト
  const IMAGE_EXTS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".tiff",
    ".tif",
    ".bmp",
    ".avif",
  ];

  // キャッシュTTL設定
  const DIR_TTL = 60 * 60 * 1000; // 1時間 - ディレクトリリストキャッシュの有効期間
  const STAT_TTL = 60 * 60 * 1000; // 1時間 - ファイル統計情報キャッシュの有効期間

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

    let names = [];
    try {
      // opendirSyncを使用したストリーミング読み込み（大量ファイル対応）
      const dirHandle = fs.opendirSync(dir); // 同期opendir（Dirオブジェクトを返す）
      let entry;
      // MAX_LIST件まで読み込み（メモリ使用量制限）
      while (
        (entry = dirHandle.readSync()) !== null &&
        names.length < getMaxList()
      ) {
        names.push(entry.name); // ファイル名を配列に追加
      }
      dirHandle.closeSync();
    } catch {
      // エラー時は従来のreaddirSyncにフォールバック
      names = origReaddirSync(dir, opts).slice(0, getMaxList()); // MAX_LIST件まで
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {}

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
      } catch (e) {}
      return stat; // ファイル統計情報を返す
    } catch {
      // ファイルが存在しない場合のデフォルトオブジェクト
      return {
        isFile: () => false,
        isDirectory: () => false,
        mtimeMs: 0,
        size: 0,
      };
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
    } catch {
      // エラー時は従来のreaddirにフォールバック
      names = await origReaddirP(dir, opts);
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {}

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
        isFile: () => false,
        isDirectory: () => false,
        mtimeMs: 0,
        size: 0,
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
    constructor(rootPath, dirCache, statCache) {
      super(rootPath);
      this.dirCache = dirCache;
      this.statCache = statCache;
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
        if (!err && Array.isArray(names)) {
          try {
            const limited = names.slice(0, getMaxList()); // MAX_LIST件までに制限
            this.dirCache.set(path, limited); // キャッシュに保存
            return callback(null, limited); // 制限後の配列を返す
          } catch (e) {
            // キャッシュ保存エラーは無視
          }
        }
        callback(err, names); // エラーまたはキャッシュ保存失敗時はそのまま返す
      });
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
        const contentTypes = {
          ".html": "text/html; charset=utf-8",
          ".htm": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".xml": "application/xml; charset=utf-8",
          ".txt": "text/plain; charset=utf-8",
          ".md": "text/markdown; charset=utf-8",
        };
        return contentTypes[ext.toLowerCase()] || "application/octet-stream";
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
        res.setMaxListeners(20);

        // シンプルな監視開始
        const requestId = Date.now(); // 簡単なリクエストID

        // IPアドレス取得
        const clientIP =
          req.connection.remoteAddress ||
          req.socket.remoteAddress ||
          (req.connection.socket
            ? req.connection.socket.remoteAddress
            : null) ||
          req.headers["x-forwarded-for"]?.split(",")[0] ||
          "unknown";

        const urlPath = req.url.split("?")[0]; // クエリパラメータを削除
        // v20 と同様に decodeURIComponent を使って表示用パスを作成
        const displayPath = decodeURIComponent(urlPath); // URLデコード
        const ext = path.extname(displayPath).toLowerCase(); // 拡張子を小文字化
        let fullPath; // フルパス

        // --- 設定UIエンドポイント: /setting を提供 ---
        // 目的: config.txt の内容を閲覧・編集する簡易UIを提供する
        try {
          const SETTING_PREFIX = "/setting";
          const cfgPath = path.join(__dirname, "..", "config.txt");

          if (
            urlPath === "/setting" ||
            urlPath.startsWith(SETTING_PREFIX + "/") ||
            urlPath === SETTING_PREFIX
          ) {
            const publicDir = path.join(__dirname, "..", "public");
            const cfgPath = path.join(__dirname, "..", "config.txt");

            // Serve main UI from public/settings.html
            if (
              req.method === "GET" &&
              (urlPath === "/setting" || urlPath === "/setting/")
            ) {
              const filePath = path.join(publicDir, "settings.html");
              try {
                const data = await fs.promises.readFile(filePath, "utf8");
                res.writeHead(200, {
                  "Content-Type": "text/html; charset=utf-8",
                });
                return res.end(data);
              } catch (e) {
                logger.warn("[setting UI serve error]", e);
                res.writeHead(500);
                return res.end("Unable to load settings UI");
              }
            }

            // Serve static files under /setting/<path> (except API paths)
            if (
              req.method === "GET" &&
              urlPath.startsWith(SETTING_PREFIX + "/") &&
              !urlPath.startsWith(SETTING_PREFIX + "/data") &&
              !urlPath.startsWith(SETTING_PREFIX + "/save")
            ) {
              const rel = urlPath.slice(SETTING_PREFIX.length + 1); // strip "setting/"
              const filePath = path.join(publicDir, rel);
              try {
                const data = await fs.promises.readFile(filePath);
                const contentType = getContentType(path.extname(filePath));
                res.writeHead(200, { "Content-Type": contentType });
                return res.end(data);
              } catch (e) {
                res.writeHead(404);
                return res.end("Not found");
              }
            }

            // GET /setting/data -> JSON with config content
            if (
              req.method === "GET" &&
              (urlPath === "/setting/data" || urlPath === "/setting/data/")
            ) {
              try {
                const txt = await fs.promises
                  .readFile(cfgPath, "utf8")
                  .catch(() => "");
                res.writeHead(200, {
                  "Content-Type": "application/json; charset=utf-8",
                });
                return res.end(JSON.stringify({ content: txt }));
              } catch (e) {
                logger.warn("[setting read error]", e);
                res.writeHead(500, {
                  "Content-Type": "application/json; charset=utf-8",
                });
                return res.end(JSON.stringify({ error: "read_error" }));
              }
            }

            // POST /setting/save -> write config content (expects JSON { content: "..." })
            if (
              req.method === "POST" &&
              (urlPath === "/setting/save" || urlPath === "/setting/save/")
            ) {
              let body = "";
              req.on("data", (chunk) => {
                body += chunk.toString();
                // 制限: 大きすぎるボディは切断
                if (body.length > 1e6) {
                  res.writeHead(413);
                  res.end("Payload too large");
                  req.connection.destroy();
                }
              });
              req.on("end", async () => {
                try {
                  const obj = JSON.parse(body || "{}");
                  if (typeof obj.content !== "string") {
                    res.writeHead(400);
                    return res.end("Bad request");
                  }
                  // backup existing config into .backup directory (ensure directory exists)
                  try {
                    const backupDir = path.join(__dirname, "..", ".backup");
                    // create backup directory if not exists (recursive to be safe)
                    await fs.promises
                      .mkdir(backupDir, { recursive: true })
                      .catch(() => {});
                    const bakPath = path.join(
                      backupDir,
                      "config.bak." + Date.now() + ".txt",
                    );
                    await fs.promises
                      .copyFile(cfgPath, bakPath)
                      .catch(() => {});
                  } catch (e) {
                    // ignore backup errors
                  }
                  // 安全のため、必ず UTF-8 で書き込む
                  await fs.promises.writeFile(cfgPath, obj.content, "utf8");
                  logger.info("[設定保存] config.txt が更新されました");
                  res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                  });
                  return res.end("OK");
                } catch (e) {
                  logger.error("[setting save error]", e);
                  res.writeHead(500);
                  return res.end("Internal error");
                }
              });
              return;
            }

            // 未対応の /setting パスは 404
            res.writeHead(404);
            return res.end("Not found");
          }
        } catch (e) {
          logger.warn("[setting ui handler error]", e);
          // 続行して通常の処理にフォールバック
        }

        try {
          fullPath = safeResolve(ROOT_PATH, urlPath);
        } catch (e) {
          res.writeHead(403);
          return res.end("Access denied");
        }

        // PROPFINDリクエストの詳細ログ出力
        if (req.method === "PROPFIND") {
          let depth = req.headers["depth"];
          if (Array.isArray(depth)) depth = depth[0];
          if (depth === undefined) depth = "(none)";
          logger.info(
            `[PROPFIND] from=${req.connection.remoteAddress} path=${displayPath} depth=${depth}`,
          );
        }

        logger.info(
          `${req.connection.remoteAddress} ${req.method} ${displayPath}`,
        );

        /**
         * 画像ファイルのGETリクエスト処理（スタック処理）
         * 画像拡張子を持つファイルへのアクセス時に変換処理をスタックに追加
         */
        if (req.method === "GET" && IMAGE_EXTS.includes(ext)) {
          logger.info(`[変換要求] ${fullPath}`);

          // 画像変換処理をスタックに追加
          requestStack.push({
            displayPath,
            res,
            processor: async () => {
              const st = await statPWrap(fullPath).catch(() => null);

              // ファイルが存在しない場合（ディレクトリやファイルでない場合）
              if (!st || !st.isFile()) {
                logger.warn(`[404 Not Found] ${fullPath}`);
                res.writeHead(404);
                return res.end("Not found");
              }

              // 画像サイズが1MB以上の場合のみキャッシュ
              const shouldCache = st.size >= getCacheMinSize();

              /**
               * 品質パラメータの取得と検証
               * クエリパラメータから品質を取得し、30-90の範囲に制限
               * 設定ファイルから動的にデフォルト品質を取得
               */
              const qParam = req.url.match(/[?&]q=(\d+)/)?.[1];
              const quality = qParam
                ? Math.min(Math.max(parseInt(qParam, 10), 30), 90)
                : getDefaultQuality();

              /**
               * キャッシュキーの生成
               * ファイルパス、リサイズサイズ、品質、変更時間、ファイルサイズを含めて
               * ファイルの変更を検知し、適切なキャッシュ管理を実現
               */
              const key = crypto
                .createHash("md5")
                .update(
                  fullPath +
                    "|" +
                    (getPhotoSize() ?? "o") +
                    "|" +
                    quality +
                    "|" +
                    String(st.mtimeMs) +
                    "|" +
                    String(st.size),
                )
                .digest("hex");
              const cachePath = activeCacheDir
                ? path.join(activeCacheDir, key + ".webp")
                : null;

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
                      "Content-Type": "image/webp",
                      "Content-Length": cst.size,
                      "Last-Modified": new Date(cst.mtimeMs).toUTCString(),
                      ETag: '"' + cst.size + "-" + Number(cst.mtimeMs) + '"',
                      Connection: "Keep-Alive",
                      "Keep-Alive": "timeout=600",
                    };
                    res.writeHead(200, headers);
                    return fs.createReadStream(cachePath).pipe(res);
                  }
                } catch (e) {
                  logger.warn("[cache read error async]", e); // キャッシュ読み込みエラーは警告ログを出力
                }
              }

              // 画像変換を実行（並列制限付き）
              await convertAndRespondWithLimit({
                fullPath,
                displayPath,
                cachePath: shouldCache ? cachePath : null,
                quality,
                Photo_Size: getPhotoSize(),
                res,
                clientIP,
              });
            },
          });

          // スタック処理なので即座にレスポンスを返さない（スタックで処理される）
          return;
        }

        /**
         * WebDAVリクエストの処理
         * 画像以外のファイルやディレクトリに対するWebDAV操作を処理
         */
        try {
          logger.info(`[WebDAV] ${req.method} ${displayPath}`);

          // レスポンスオブジェクトの型チェック（WebDAVサーバーとの互換性確保）
          if (typeof res.setHeader === "function") {
            res.setHeader("Connection", "Keep-Alive");
            res.setHeader("Keep-Alive", "timeout=120");
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader(
              "Cache-Control",
              "public, max-age=0, must-revalidate",
            );
          }

          // WebDAVレスポンスの圧縮処理
          if (getCompressionEnabled() && typeof res.setHeader === "function") {
            const acceptEncoding = req.headers["accept-encoding"] || "";
            const supportsGzip = acceptEncoding.includes("gzip");

            if (supportsGzip) {
              // レスポンスのラッパーを作成して圧縮処理を追加
              const originalWriteHead = res.writeHead;
              const originalWrite = res.write;
              const originalEnd = res.end;

              let responseData = [];
              let headersWritten = false;

              res.writeHead = function (statusCode, statusMessage, headers) {
                if (typeof statusCode === "object") {
                  headers = statusCode;
                  statusCode = 200;
                }
                headers = headers || {};

                // Content-Typeを確認（画像ファイルは除外）
                const contentType =
                  headers["content-type"] ||
                  res.getHeader("content-type") ||
                  "";
                const isTextResponse =
                  contentType.includes("xml") ||
                  contentType.includes("html") ||
                  contentType.includes("json") ||
                  contentType.includes("text");
                
                // 画像ファイルは圧縮対象から除外
                const isImageResponse =
                  contentType.includes("image/") ||
                  contentType.includes("video/") ||
                  contentType.includes("audio/") ||
                  contentType.includes("application/octet-stream");

                if (isTextResponse && !isImageResponse) {
                  // テキストレスポンスで画像ファイル以外の場合は圧縮準備
                  headers["Vary"] = "Accept-Encoding";
                }

                headersWritten = true;
                return originalWriteHead.call(
                  this,
                  statusCode,
                  statusMessage,
                  headers,
                );
              };

              res.write = function (chunk, encoding) {
                if (chunk) {
                  responseData.push(
                    Buffer.isBuffer(chunk)
                      ? chunk
                      : Buffer.from(chunk, encoding || "utf8"),
                  );
                }
                return true;
              };

              res.end = function (chunk, encoding) {
                // 既にレスポンスが終了している場合は何もしない
                if (res.headersSent && res.finished) {
                  return;
                }

                if (chunk) {
                  responseData.push(
                    Buffer.isBuffer(chunk)
                      ? chunk
                      : Buffer.from(chunk, encoding || "utf8"),
                  );
                }

                if (responseData.length === 0) {
                  return originalEnd.call(this);
                }

                const fullData = Buffer.concat(responseData);
                const contentType = res.getHeader("content-type") || "";
                const isTextResponse =
                  contentType.includes("xml") ||
                  contentType.includes("html") ||
                  contentType.includes("json") ||
                  contentType.includes("text");
                
                // 画像ファイルは圧縮対象から除外
                const isImageResponse =
                  contentType.includes("image/") ||
                  contentType.includes("video/") ||
                  contentType.includes("audio/") ||
                  contentType.includes("application/octet-stream");

                // 最小サイズ制限（1KB未満は圧縮しない）
                const MIN_COMPRESS_SIZE = 1024;
                if (!isTextResponse || isImageResponse || fullData.length < MIN_COMPRESS_SIZE) {
                  logger.info(
                    `[圧縮スキップ] ${displayPath} - 条件未満: テキスト=${isTextResponse}, 画像=${isImageResponse}, サイズ=${fullData.length}`,
                  );
                  return originalEnd.call(this, fullData);
                }

                // 圧縮処理
                zlib.gzip(
                  fullData,
                  {
                    level: 9,
                    memLevel: 9,
                    windowBits: 15,
                  },
                  (err, compressed) => {
                    // 圧縮処理中にレスポンスが既に終了している場合は何もしない
                    if (res.headersSent && res.finished) {
                      return;
                    }

                    if (err) {
                      logger.warn(
                        `[圧縮エラー] ${displayPath}: ${err.message}`,
                      );
                      return originalEnd.call(this, fullData);
                    }

                    // 圧縮効果の確認
                    const compressionRatio =
                      compressed.length / fullData.length;
                    const threshold = getCompressionThreshold();
                    logger.info(
                      `[圧縮結果] ${displayPath} - 圧縮率: ${(compressionRatio * 100).toFixed(1)}%, 閾値: ${(threshold * 100).toFixed(1)}%`,
                    );

                    if (compressionRatio < threshold) {
                      // 圧縮レスポンスの送信
                      res.setHeader("Content-Encoding", "gzip");
                      res.setHeader("Content-Length", compressed.length);

                      logger.info(
                        `[圧縮適用] ${displayPath} サイズ: ${fullData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`,
                      );
                      originalEnd.call(this, compressed);
                    } else {
                      logger.info(
                        `[圧縮スキップ] ${displayPath} - 圧縮効果が不十分: ${(compressionRatio * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(1)}%`,
                      );
                      originalEnd.call(this, fullData);
                    }
                  },
                );
              };
            }
          }

          // テキストファイルの圧縮処理（WebDAV処理の前）
          const textExts = [
            ".html",
            ".htm",
            ".css",
            ".js",
            ".json",
            ".xml",
            ".txt",
            ".md",
          ];
          const imageExts = [
            ".jpg",
            ".jpeg",
            ".png",
            ".gif",
            ".webp",
            ".bmp",
            ".tiff",
            ".tif",
            ".avif",
            ".svg",
          ];
          const isTextFile = textExts.includes(ext.toLowerCase());
          const isImageFile = imageExts.includes(ext.toLowerCase());

          if (
            getCompressionEnabled() &&
            req.method === "GET" &&
            isTextFile &&
            !isImageFile &&
            typeof res.setHeader === "function"
          ) {
            // 圧縮対応の確認
            const acceptEncoding = req.headers["accept-encoding"] || "";
            const supportsGzip = acceptEncoding.includes("gzip");

            if (supportsGzip) {
              try {
                // ファイルの存在確認
                const fileStat = await statPWrap(fullPath).catch(() => null);
                if (fileStat && fileStat.isFile() && fileStat.size > 1024) {
                  // 1KB以上の場合のみ圧縮
                  // ファイル読み込みと圧縮（高性能環境向け非同期処理）
                  const fileData = await fs.promises.readFile(fullPath);
                  const compressed = await new Promise((resolve, reject) => {
                    zlib.gzip(
                      fileData,
                      {
                        level: 9,
                        memLevel: 9,
                        windowBits: 15,
                      },
                      (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                      },
                    );
                  });

                  // 圧縮効果の確認（環境変数で閾値を制御可能）
                  const compressionRatio = compressed.length / fileData.length;
                  if (compressionRatio < getCompressionThreshold()) {
                    // 圧縮レスポンスの送信
                    res.writeHead(200, {
                      "Content-Type": getContentType(ext),
                      "Content-Encoding": "gzip",
                      "Content-Length": compressed.length,
                      Vary: "Accept-Encoding",
                    });
                    res.end(compressed);
                    logger.info(
                      `[ファイル圧縮完了] ${displayPath} サイズ: ${fileData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`,
                    );
                    return; // 圧縮レスポンスを送信して処理終了
                  }
                }
              } catch (compressError) {
                logger.warn(
                  `[ファイル圧縮エラー] ${displayPath}: ${compressError.message}`,
                );
              }
            }
          }

          server.executeRequest(req, res);
        } catch (e) {
          logger.error("WebDAV error", e);
          if (!res.headersSent && typeof res.writeHead === "function") {
            res.writeHead(500);
            res.end("WebDAV error");
          } else if (typeof res.end === "function") {
            res.end();
          }
        }
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
      httpServer.setTimeout(60000);
      httpServer.keepAliveTimeout = 60000;
      httpServer.headersTimeout = 65000;

      /**
       * HTTPサーバーのエラーハンドリング
       * EADDRINUSE等のエラーでクラッシュしないようにエラーイベントを先に登録
       */
      httpServer.on("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
          logger.error(
            `ポート ${PORT} は既に使用されています。サーバーの起動をスキップします。`,
          );
        } else {
          logger.error("HTTP server error", err);
        }
      });

      /**
       * HTTPサーバーの起動
       * 指定されたポートでサーバーを起動し、起動完了をログ出力
       */
      httpServer.listen(PORT, () => {
        logger.info(`✅ WebDAV 起動: http://localhost:${PORT}/`);
        logger.info(
          `[INFO] キャッシュDir=${activeCacheDir || "無効"} / MAX_LIST=${getMaxList()} / Photo_Size=${getPhotoSize() ?? "オリジナル"}`,
        );
        logger.info(
          `[INFO] 圧縮機能=${getCompressionEnabled() ? "有効" : "無効"} / 圧縮閾値=${(getCompressionThreshold() * 100).toFixed(1)}%`,
        );
      });
    },
  );
}

module.exports = {
  startWebDAV,
};
