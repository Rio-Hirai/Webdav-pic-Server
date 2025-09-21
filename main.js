// === モジュール読み込み・共通初期化 ===
// Node.js標準モジュール群
const fs = require("fs"); // ファイルシステム操作 - 同期/非同期ファイルI/O、ディレクトリ操作、opendirSync等のストリーミングAPI
const path = require("path"); // パス操作 - クロスプラットフォーム対応のパス解決、正規化、セキュリティチェック用
const http = require("http"); // HTTPサーバー - 低レベルHTTPサーバー実装、Keep-Alive、タイムアウト設定
const crypto = require("crypto"); // 暗号化・ハッシュ生成 - MD5/SHA256等のハッシュ関数、キャッシュキー生成用
const os = require("os"); // OS情報取得 - CPU数、メモリ情報、プラットフォーム判定、並列度最適化用
const stream = require("stream"); // ストリーム処理 - PassThrough、pipeline等のストリーム操作、メモリ効率化
const { promisify } = require("util"); // コールバック→Promise変換 - 非同期処理の統一化、pipelineのPromise化
const { execFile, spawn } = require("child_process"); // 外部プロセス実行 - ImageMagick等の外部コマンド呼び出し、フォールバック処理
const zlib = require("zlib"); // 圧縮処理（現在未使用） - gzip/deflate圧縮、将来のHTTP圧縮対応用

// 外部ライブラリ
const sharp = require("sharp"); // 高性能画像変換ライブラリ - libvipsベース、WebP/JPEG/PNG変換、メタデータ取得、回転補正
const webdav = require("webdav-server").v2; // WebDAVサーバー実装 - RFC4918準拠のWebDAVプロトコル、PROPFIND/PROPPATCH等
const pLimit = require("p-limit"); // 並列処理制御 - 同時実行数の制限によるリソース保護、メモリ枯渇防止
const { LRUCache } = require("lru-cache"); // LRUキャッシュ実装 - メモリ効率的なキャッシュ管理、TTL対応、サイズ制限

/**
 * タイムスタンプ生成関数
 * ISO8601形式のUTCタイムスタンプを生成（ログ出力用）
 * @returns {string} ISO8601形式のタイムスタンプ
 */
function timestamp() {
  // 日本時間 (JST) の ISO 8601 形式で出力する
  // 例: 2025-09-21T14:03:05
  const dt = new Date();
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(dt);
  // Intl.DateTimeFormat with 'sv-SE' returns 'YYYY-MM-DD HH:mm:ss'
  return formatted.replace(" ", "T");
}

/**
 * ロガー実装
 * 構造化ログ出力のためのシンプルなロガー
 * - 全ログにISO8601タイムスタンプを付与
 * - レベル別の出力先分離（info/warn: stdout, error: stderr）
 * - child/flushメソッドは互換性のため空実装
 */
const logger = {
  info: (...args) => console.log(`[${timestamp()}] INFO: ${args.join(" ")}`), // infoはstdoutに出力
  warn: (...args) => console.log(`[${timestamp()}] WARN: ${args.join(" ")}`), // warnはstdoutに出力
  error: (...args) => console.error(`[${timestamp()}] ERROR: ${args.join(" ")}`), // errorはstderrに出力
  child: () => logger, // 子ロガー（互換性のため）
  flush: () => {}, // フラッシュ（互換性のため）
};

// ImageMagickコマンドパス設定
// 環境変数MAGICK_PATHが設定されていればそれを使用、未設定の場合は"magick"をデフォルトとする
const MAGICK_CMD = process.env.MAGICK_PATH || "magick";

/**
 * Sharpライブラリのパフォーマンス最適化設定
 * - concurrency: 並列処理数をCPU数-1に設定（メインスレッドを残す）
 * - cache: メモリキャッシュ200MB、ファイルキャッシュ100個、アイテムキャッシュ200個
 * これらの設定により、大量の画像変換処理時のメモリ効率と処理速度を向上
 *
 * 技術的詳細:
 * - concurrency制限により、CPUコア数に応じた最適な並列度を実現
 * - メモリキャッシュにより、同一画像の再変換時の高速化
 * - ファイルキャッシュにより、ディスクI/Oの最適化
 * - アイテムキャッシュにより、メタデータ取得の高速化
 */
try {
  const cpuCount = Math.max(1, os.cpus().length - 1); // 最低1、最大はCPU数-1
  sharp.concurrency(cpuCount); // 並列処理数の制限
  sharp.cache({
    memory: 200, // メモリキャッシュサイズ（MB）
    files: 100, // ファイルキャッシュ数
    items: 200, // アイテムキャッシュ数
  });
  logger.info(`sharp configured: concurrency=${cpuCount}`);
} catch (e) {
  logger.warn("failed to configure sharp performance settings", e);
}

/**
 * ストリーム処理ユーティリティ
 * - PassThrough: データをそのまま通過させるストリーム（複数出力先への分岐用）
 * - pipeline: 複数ストリームを安全に接続し、エラーハンドリングを自動化
 *
 * 技術的詳細:
 * - PassThrough: 変換データをキャッシュ書き込みとHTTPレスポンスの両方に分岐
 * - pipeline: ストリーム間のエラー伝播とリソース自動解放を保証
 * - promisify: コールバック形式のpipelineをPromise化してasync/await対応
 */
const PassThrough = stream.PassThrough;
const pipeline = promisify(stream.pipeline);

/**
 * 画像キャッシュシステム設定
 * 変換済み画像の一時保存による高速化とサーバー負荷軽減を実現（したはず？ 高スペックCPUだと違いが分からない）
 *
 * 技術的詳細:
 * - ファイルベースキャッシュ: 変換結果をWebPファイルとして保存
 * - 原子的更新: 一時ファイル→リネームによる整合性保証
 * - TTL管理: 期限切れファイルの自動削除によるディスク容量管理
 * - サイズフィルタ: 小ファイルはキャッシュ対象外（オーバーヘッド回避）
 */
const CACHE_DIR = "Y:/caches/webdav/tmp"; // キャッシュファイル保存ディレクトリ
const CACHE_MIN_SIZE = 1 * 1024 * 1024; // 1MB - キャッシュ対象の最小ファイルサイズ
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分 - キャッシュクリーニング実行間隔
const CACHE_TTL_MS = 5 * 60 * 1000; // 5分 - キャッシュファイルの有効期間

/**
 * キャッシュディレクトリの完全リセット関数（同期版）
 * 起動時の初期化処理で使用される高速な同期削除処理
 *
 * @param {string} dir - 削除対象ディレクトリパス
 *
 * 処理フロー:
 * 1. ディレクトリ存在チェック
 * 2. エントリをwithFileTypesで取得（ファイル/ディレクトリ判定用）
 * 3. ディレクトリの場合は再帰的に削除
 * 4. ファイルの場合は直接削除
 *
 * 注意: 同期処理のため大量ファイルがある場合はブロッキングする可能性
 */
function resetCacheSync(dir) {
  if (!fs.existsSync(dir)) return;

  // withFileTypes: true により Dirent オブジェクトを取得（isDirectory()等のメソッドが使用可能）
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);

    if (ent.isDirectory()) {
      resetCacheSync(full); // サブディレクトリを再帰的に削除
      fs.rmdirSync(full, { recursive: true }); // 空になったディレクトリを削除
    } else {
      fs.unlinkSync(full); // ファイルを削除
    }
  }
}

// キャッシュディレクトリ作成＆リセット（初回起動時）
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
logger.info("=== キャッシュリセット中... ===");
resetCacheSync(CACHE_DIR);
logger.info("=== キャッシュリセット完了 ===");

/**
 * キャッシュディレクトリの初期化と定期クリーニング設定
 */
// キャッシュディレクトリが存在しない場合は作成（recursive: true で親ディレクトリも自動作成）
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/**
 * キャッシュファイルの定期クリーニング関数（非同期版）
 * 定期的に実行され、期限切れのキャッシュファイルを削除してディスク容量を節約
 *
 * @param {string} dir - クリーニング対象ディレクトリパス
 *
 * 処理内容:
 * 1. ディレクトリ内のエントリを非同期で取得
 * 2. ディレクトリの場合は再帰的にクリーニング
 * 3. 空になったディレクトリは削除
 * 4. .webpファイルでTTL期限切れのものは削除
 *
 * エラーハンドリング: 各操作でエラーが発生しても処理を継続（.catch(() => {})）
 */
async function cleanupCache(dir) {
  // ディレクトリ読み込み失敗時は空配列を返す
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const ent of entries) {
    const full = path.join(dir, ent.name);

    if (ent.isDirectory()) {
      // サブディレクトリを再帰的にクリーニング
      await cleanupCache(full);

      // 空になったディレクトリを削除
      const remaining = await fs.promises.readdir(full).catch(() => []);
      if (remaining.length === 0) {
        await fs.promises.rmdir(full).catch(() => {}); // 削除失敗は無視
      }
    } else if (ent.isFile() && full.endsWith(".webp")) {
      // .webpファイルのTTLチェック
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        await fs.promises.unlink(full).catch(() => {}); // 削除失敗は無視
      }
    }
  }
}

// 定期クリーニングの開始（30分間隔で実行）
setInterval(() => cleanupCache(CACHE_DIR), CLEANUP_INTERVAL_MS);

/**
 * サーバー設定配列
 * 複数のWebDAVサーバーを異なる設定で同時起動するための設定定義
 * 各サーバーは用途に応じて最適化された設定を持つ
 */
const serverConfigs = [
  {
    PORT: 1900, // サーバーポート番号
    ROOT_PATH: "Z:/書籍", // WebDAVのルートディレクトリ
    MAX_LIST: 128 * 2, // ディレクトリリスト表示の最大件数（256件）
    Photo_Size: 128 * 7, // 画像リサイズサイズ（896px）
    defaultQuality: 50, // WebP変換のデフォルト品質（50%）
    label: "軽量版", // ログ出力用の識別ラベル
  },
  {
    PORT: 1901, // サーバーポート番号
    ROOT_PATH: "Z:/書籍", // WebDAVのルートディレクトリ
    MAX_LIST: 128 * 8, // ディレクトリリスト表示の最大件数（1024件）
    Photo_Size: 128 * 8, // 画像リサイズサイズ（1024px）
    defaultQuality: 70, // WebP変換のデフォルト品質（70%）
    label: "バランス版", // ログ出力用の識別ラベル
  },
  {
    PORT: 1902, // サーバーポート番号
    ROOT_PATH: "Z:/書籍", // WebDAVのルートディレクトリ
    MAX_LIST: 128 * 32, // ディレクトリリスト表示の最大件数（4096件）
    Photo_Size: null, // リサイズなし（オリジナルサイズ）
    defaultQuality: 85, // WebP変換のデフォルト品質（85%）
    label: "オリジナル版", // ログ出力用の識別ラベル
  },
];

/**
 * メインループ: 複数サーバーの起動
 * 設定配列の各要素に対してWebDAVサーバーを起動
 */
serverConfigs.forEach((config) => startWebDAV(config));

/**
 * WebDAVサーバー起動関数
 * 指定された設定でWebDAVサーバーとHTTPサーバーを起動し、画像変換機能を提供
 *
 * @param {Object} config - サーバー設定オブジェクト
 * @param {number} config.PORT - サーバーポート番号
 * @param {string} config.ROOT_PATH - WebDAVルートディレクトリ
 * @param {number} config.MAX_LIST - ディレクトリリスト最大件数
 * @param {number|null} config.Photo_Size - 画像リサイズサイズ（null=リサイズなし）
 * @param {number} config.defaultQuality - WebP変換デフォルト品質
 * @param {string} config.label - ログ識別ラベル
 */
function startWebDAV(config) {
  // 設定の分割代入
  const { PORT, ROOT_PATH, MAX_LIST, Photo_Size, defaultQuality, label } = config;

  // 画像変換対象の拡張子リスト
  const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".avif"];

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
    max: 50000, // 最大50,000エントリ（ディレクトリリスト）
    ttl: DIR_TTL, // TTL: 1時間
  });

  const statCache = new LRUCache({
    max: 200000, // 最大200,000エントリ（ファイル統計情報）
    ttl: STAT_TTL, // TTL: 1時間
  });

  // 並列処理制限: CPU数分の同時実行を許可
  // pLimitにより、同時実行数を制限してメモリ枯渇とCPU過負荷を防止
  const limit = pLimit(os.cpus().length);

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
    if (cached) return cached.slice(0, MAX_LIST); // キャッシュヒット時はMAX_LIST件まで返す

    let names = [];
    try {
      // opendirSyncを使用したストリーミング読み込み（大量ファイル対応）
      const dirHandle = fs.opendirSync(dir); // 同期opendir（Dirオブジェクトを返す）
      let entry;
      // MAX_LIST件まで読み込み（メモリ使用量制限）
      while ((entry = dirHandle.readSync()) !== null && names.length < MAX_LIST) {
        names.push(entry.name); // ファイル名を配列に追加
      }
      dirHandle.closeSync();
    } catch {
      // エラー時は従来のreaddirSyncにフォールバック
      names = origReaddirSync(dir, opts).slice(0, MAX_LIST); // MAX_LIST件まで
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {}

    return names; // ファイル名配列を返す
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
      const stat = origStatSync(p, opts);
      // キャッシュ保存（エラーは無視）
      try {
        statCache.set(p, stat); // キャッシュに保存
      } catch (e) {}
      return stat; // 統計情報を返す
    } catch {
      // ファイルが存在しない場合のデフォルトオブジェクト
      return {
        isFile: () => false, // 存在しない場合は常にfalseを返す
        isDirectory: () => false, // 存在しない場合は常にfalseを返す
        mtimeMs: 0, // 存在しない場合は0を返す
        size: 0, // 存在しない場合は0を返す
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
    if (cached) return cached.slice(0, MAX_LIST); // キャッシュヒット時はMAX_LIST件まで返す

    let names = []; // ファイル名配列初期化
    try {
      // 非同期opendirを使用したストリーミング読み込み
      const dirHandle = await fs.promises.opendir(dir);
      for await (const entry of dirHandle) {
        names.push(entry.name); // ファイル名を配列に追加
        if (names.length >= MAX_LIST) break; // MAX_LIST件で制限
      }
      await dirHandle.close(); // ディレクトリハンドルを閉じる
    } catch {
      // エラー時は従来のreaddirにフォールバック
      names = await origReaddirP(dir, opts); // そのまま全件取得
    }

    // キャッシュ保存（エラーは無視）
    try {
      dirCache.set(dir, names); // キャッシュに保存
    } catch (e) {}

    return names; // ファイル名配列を返す
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
      const stat = await origStatP(p, opts); // 非同期stat取得
      // キャッシュ保存（エラーは無視）
      try {
        statCache.set(p, stat); // キャッシュに保存
      } catch (e) {}
      return stat; // 統計情報を返す
    } catch {
      // ファイルが存在しない場合のデフォルトオブジェクト
      return {
        isFile: () => false, // 存在しない場合は常にfalseを返す
        isDirectory: () => false, // 存在しない場合は常にfalseを返す
        mtimeMs: 0, // 存在しない場合は0を返す
        size: 0, // 存在しない場合は0を返す
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
      const depth = (Array.isArray(depthHeader) ? depthHeader[0] : depthHeader) || "1"; // デフォルトは"1"

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
        if (cached) return callback(null, cached.slice(0, MAX_LIST)); // キャッシュヒット時はMAX_LIST件まで返す
      } catch (e) {
        // キャッシュエラー時は親クラスの実装にフォールバック
      }

      // 親クラスの_readdirを呼び出し
      super._readdir(path, ctx, (err, names) => {
        if (!err && Array.isArray(names)) {
          try {
            const limited = names.slice(0, MAX_LIST); // MAX_LIST件までに制限
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
  server.setFileSystem("/", new CachedFileSystem(ROOT_PATH, dirCache, statCache), (success) => {
    if (!success) {
      logger.error(`マウント失敗: ${label}`); // マウント失敗時はエラーログを出力
      process.exit(1); // 致命的エラーのためプロセス終了
    }

    /**
     * HTTPサーバー関連の初期化
     * fsのラッパーをインストールして、画像変換のin-flight管理等を用意
     * グローバルなfs関数をキャッシュ機能付きのラッパーに置き換える
     */
    try {
      fs.readdirSync = readdirSyncWrap; // 同期ディレクトリ読み込みをキャッシュ化
      fs.statSync = statSyncWrap; // 同期ファイル統計取得をキャッシュ化
      fs.promises.readdir = readdirPWrap; // 非同期ディレクトリ読み込みをキャッシュ化
      fs.promises.stat = statPWrap; // 非同期ファイル統計取得をキャッシュ化
    } catch (e) {
      logger.warn("[warn] failed to install fs wrappers", e); // ラッパーインストール失敗は警告ログを出力
    }

    /**
     * 画像変換の重複排除とエラーハンドリング設定
     * 同じ画像の同時変換要求を効率的に処理し、サーバー負荷を軽減
     *
     * 技術的詳細:
     * - in-flight deduplication: 同一キーの変換要求を統合
     * - タイムアウト制御: 無限待機を防ぐタイムアウト設定
     * - 失敗バックオフ: 連続失敗時の再試行制御
     * - リトライ制限: 無限リトライを防ぐ回数制限
     */
    const inflight = new Map(); // 進行中の変換を管理するマップ
    const INFLIGHT_TIMEOUT_MS = 30 * 1000; // 30秒で先行変換待ちをタイムアウト
    const MAX_INFLIGHT_RETRIES = 1; // 最大リトライ回数（失敗時）
    const RETRY_DELAY_MS = 500; // リトライ間隔
    const FAILED_BACKOFF_MS = 5 * 1000; // 失敗後のバックオフ期間（5秒）
    const failedCache = new LRUCache({ max: 10000, ttl: FAILED_BACKOFF_MS }); // 直近の失敗を記録して直ぐに再試行を避ける

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
        if (!(lc === rr || lc.startsWith(rr + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
      } else {
        if (!(candidate === rootResolved || candidate.startsWith(rootResolved + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
      }
      return candidate; // 安全なパスを返す
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
    const httpServer = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0]; // クエリパラメータを削除
      // v20 と同様に decodeURIComponent を使って表示用パスを作成
      const displayPath = decodeURIComponent(urlPath); // URLデコード
      const ext = path.extname(displayPath).toLowerCase(); // 拡張子を小文字化
      let fullPath; // フルパス

      try {
        fullPath = safeResolve(ROOT_PATH, urlPath); // セキュアなパス解決
      } catch (e) {
        res.writeHead(403); // Forbidden
        return res.end("Access denied"); // アクセス拒否メッセージ
      }

      // PROPFINDリクエストの詳細ログ出力
      if (req.method === "PROPFIND") {
        let depth = req.headers["depth"]; // 深さ
        if (Array.isArray(depth)) depth = depth[0]; // 配列の場合は最初の要素を取得
        if (depth === undefined) depth = "(none)"; // 深さが未定義の場合は'(none)'
        logger.info(`[PROPFIND] [${label}] from=${req.connection.remoteAddress} path=${displayPath} depth=${depth}`);
      }

      logger.info(`[${label}] ${req.connection.remoteAddress} ${req.method} ${displayPath}`); // 基本ログ出力

      /**
       * 画像ファイルのGETリクエスト処理
       * 画像拡張子を持つファイルへのアクセス時に変換処理を実行
       */
      if (req.method === "GET" && IMAGE_EXTS.includes(ext)) {
        return limit(async () => {
          logger.info(`[変換要求][${label}] ${fullPath}`); // 変換要求ログを出力
          const st = await statPWrap(fullPath).catch(() => null); // ファイルの情報を取得

          // ファイルが存在しない場合（ディレクトリやファイルでない場合）
          if (!st || !st.isFile()) {
            logger.warn(`[404 Not Found][${label}] ${fullPath}`); // 警告ログを出力
            res.writeHead(404); // Not Found
            return res.end("Not found"); // エラーメッセージを返す
          }

          // 画像サイズが1MB以上の場合のみキャッシュ
          const shouldCache = st.size >= CACHE_MIN_SIZE; // キャッシュを使用するかどうか

          /**
           * 品質パラメータの取得と検証
           * クエリパラメータから品質を取得し、30-90の範囲に制限
           */
          const qParam = req.url.match(/[?&]q=(\d+)/)?.[1]; // クエリからqualityを取得
          const quality = qParam
            ? Math.min(Math.max(parseInt(qParam, 10), 30), 90) // 30から90の範囲でqualityを取得
            : defaultQuality; // デフォルト品質を使用

          /**
           * キャッシュキーの生成
           * ファイルパス、リサイズサイズ、品質、変更時間、ファイルサイズを含めて
           * ファイルの変更を検知し、適切なキャッシュ管理を実現
           *
           * 技術的詳細:
           * - MD5ハッシュ: 固定長のキャッシュキー生成
           * - 変更検知: mtimeMsとsizeによるファイル変更の検出
           * - パラメータ包含: 品質・リサイズ設定の変更も検知
           * - 衝突回避: 複数パラメータの組み合わせによる一意性保証
           */
          const key = crypto
            .createHash("md5") // MD5ハッシュアルゴリズムを使用
            .update(fullPath + "|" + (Photo_Size ?? "o") + "|" + quality + "|" + String(st.mtimeMs) + "|" + String(st.size)) // 複数パラメータを連結
            .digest("hex"); // キャッシュキーを生成
          const cachePath = path.join(CACHE_DIR, key + ".webp"); // キャッシュファイルのパス

          /**
           * キャッシュファイルの存在確認とレスポンス
           * 非同期でチェックしてブロッキングを避ける
           */
          if (shouldCache) {
            try {
              const cst = await statPWrap(cachePath).catch(() => null); // キャッシュファイルの情報を取得
              if (cst && cst.isFile && cst.isFile()) {
                // キャッシュファイルが存在する場合、直接レスポンス
                const headers = {
                  "Content-Type": "image/webp", // WebP画像のMIMEタイプ
                  "Content-Length": cst.size, // キャッシュファイルのサイズ
                  "Last-Modified": new Date(cst.mtimeMs).toUTCString(), // 最終更新日時
                  ETag: '"' + cst.size + "-" + Number(cst.mtimeMs) + '"', // ETagヘッダー
                  Connection: "Keep-Alive", // Keep-Alive接続
                  "Keep-Alive": "timeout=600", // Keep-Aliveタイムアウト
                };
                res.writeHead(200, headers); // OK
                return fs.createReadStream(cachePath).pipe(res); // キャッシュファイルをストリームでレスポンス
              }
            } catch (e) {
              logger.warn("[cache read error async]", e); // キャッシュ読み込みエラーは警告ログを出力
            }
          }

          /**
           * 失敗バックオフチェック
           * 最近失敗した変換の即座な再試行を避ける
           */
          if (shouldCache && failedCache.has(key)) {
            logger.warn(`[backoff][${label}] recent failure for key, skipping retry: ${key}`); // 警告ログを出力
            res.writeHead(503); // Service Unavailable
            return res.end("Temporary conversion failure, try again later"); // 一時的なエラーメッセージを返す
          }

          /**
           * 重複変換の排除（in-flight deduplication）
           * 同じキーで変換中の場合は、その完了を待つ
           */
          if (shouldCache && inflight.has(key)) {
            try {
              await inflight.get(key); // 進行中の変換完了を待機
              const cst = await statPWrap(cachePath).catch(() => null); // キャッシュファイルの情報を再取得
              if (cst && cst.isFile && cst.isFile()) {
                // 変換完了後、キャッシュファイルをレスポンス
                res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": cst.size }); // OK
                return fs.createReadStream(cachePath).pipe(res); // キャッシュファイルをストリームでレスポンス
              }
            } catch (e) {
              // 先行変換が失敗したら落ちて次で再生成（待ちがタイムアウト等で失敗）
              logger.warn("[inflight wait error async]", e); // 警告ログを出力
            }
          }

          /**
           * 画像変換実行関数
           * リトライと失敗バックオフ付きで変換を実行し、オプションで原子的にキャッシュ
           */
          const performConversion = async () => {
            let attempt = 0; // リトライ回数カウンタ
            while (true) {
              try {
                await convertAndRespond({ fullPath, displayPath, cachePath: shouldCache ? cachePath : null, quality, Photo_Size, label, fs, sharp, execFile, res }); // 変換とレスポンス送信
                return; // 成功
              } catch (e) {
                attempt++; // リトライ回数をインクリメント
                logger.warn(`[inflight convert error][${label}] key=${key} attempt=${attempt} err=${e && e.message ? e.message : e}`); // 警告ログを出力
                if (attempt > MAX_INFLIGHT_RETRIES) {
                  // 迅速な再試行を避けるために失敗を記録
                  try {
                    failedCache.set(key, true); // 失敗をキャッシュに記録
                  } catch (ee) {}
                  throw e; // 最大リトライ回数を超えたらエラーをスロー
                }
                // リトライ前の短いバックオフ
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS)); // リトライ間隔待機
              }
            }
          };

          const work = performConversion(); // 変換処理を開始

          /**
           * キャッシュ使用時のin-flight管理
           * 待機者が無限にハングしないようにタイムアウトでラップ
           */
          if (shouldCache) {
            // 待機者が無限にハングしないようにタイムアウトでラップ
            const timed = Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error("inflight timeout")), INFLIGHT_TIMEOUT_MS))]); // タイムアウト付きで待機
            inflight.set(key, timed); // in-flightマップに登録
            timed.then(() => inflight.delete(key)).catch(() => inflight.delete(key)); // 完了時にin-flightマップから削除
          }

          return work; // 変換処理のPromiseを返す
        });
      }

      /**
       * WebDAVリクエストの処理
       * 画像以外のファイルやディレクトリに対するWebDAV操作を処理
       */
      try {
        logger.info(`[WebDAV][${label}] ${req.method} ${displayPath}`); // WebDAVリクエストのログを出力
        res.setHeader("Connection", "Keep-Alive"); // Keep-Alive接続
        res.setHeader("Keep-Alive", "timeout=120"); // Keep-Aliveタイムアウト
        res.setHeader("Accept-Ranges", "bytes"); // バイトレンジリクエストをサポート
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate"); // キャッシュ制御ヘッダー
        server.executeRequest(req, res); // WebDAVサーバーにリクエストを処理させる
      } catch (e) {
        logger.error("WebDAV error", e); // エラーログを出力
        if (!res.headersSent) {
          res.writeHead(500); // Internal Server Error
          res.end("WebDAV error"); // エラーメッセージを返す
        } else res.end(); // 既にヘッダーが送信されている場合はレスポンスを終了
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
    httpServer.setTimeout(60000); // ソケットタイムアウト: 60秒
    httpServer.keepAliveTimeout = 60000; // Keep-Aliveタイムアウト: 60秒
    httpServer.headersTimeout = 65000; // ヘッダー受信タイムアウト: 65秒

    /**
     * HTTPサーバーのエラーハンドリング
     * EADDRINUSE等のエラーでクラッシュしないようにエラーイベントを先に登録
     */
    httpServer.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        logger.error(`ポート ${PORT} は既に使用されています。${label} の起動をスキップします。`); // ポート使用中エラーは特別扱い
      } else {
        logger.error("HTTP server error", err); // その他のエラーはエラーログを出力
      }
    });

    /**
     * HTTPサーバーの起動
     * 指定されたポートでサーバーを起動し、起動完了をログ出力
     */
    httpServer.listen(PORT, () => {
      logger.info(`✅ WebDAV [${label}] 起動: http://localhost:${PORT}/`); // 起動完了ログを出力
      logger.info(`[INFO] キャッシュDir=${CACHE_DIR} / MAX_LIST=${MAX_LIST} / Photo_Size=${Photo_Size ?? "オリジナル"}`); // キャッシュ設定ログを出力
    });
  });
}

/**
 * ======== 画像変換処理システム ========
 *
 * 高性能な画像変換処理を提供する関数群
 * - Sharpライブラリをメインエンジンとして使用
 * - ImageMagickをフォールバックとして使用
 * - ストリーミング処理によるメモリ効率化
 * - 原子的キャッシュ更新によるデータ整合性保証
 */

/**
 * 画像変換・レスポンス送信関数
 * 指定された画像ファイルをWebP形式に変換し、HTTPレスポンスとして送信
 *
 * @param {Object} params - 変換パラメータ
 * @param {string} params.fullPath - 変換対象画像のフルパス
 * @param {string} params.displayPath - 表示用パス（ログ出力用）
 * @param {string|null} params.cachePath - キャッシュファイルパス（null=キャッシュなし）
 * @param {number} params.quality - WebP変換品質（30-90）
 * @param {number|null} params.Photo_Size - リサイズサイズ（null=リサイズなし）
 * @param {string} params.label - サーバーラベル（ログ識別用）
 * @param {Object} params.fs - ファイルシステムモジュール
 * @param {Object} params.sharp - Sharpライブラリインスタンス
 * @param {Function} params.execFile - 外部コマンド実行関数
 * @param {Object} params.res - HTTPレスポンスオブジェクト
 *
 * @returns {Promise<void>} 変換完了時にresolve
 *
 * 処理フロー:
 * 1. Sharpライブラリで画像変換を試行
 * 2. 失敗時はImageMagickにフォールバック
 * 3. ストリーミング処理でメモリ効率化
 * 4. キャッシュファイルの原子的更新
 * 5. HTTPレスポンスへの直接ストリーミング
 */
async function convertAndRespond({ fullPath, displayPath, cachePath, quality, Photo_Size, label, fs, sharp, execFile, res }) {
  // 軽量版（高速化設定）かどうかを判定
  const isFast = label.includes("軽量版"); // 軽量版はラベルに"軽量版"を含む

  // Promise を返すことで呼び出し側が完了を待てるようにする
  return new Promise(async (resolve, reject) => {
    /**
     * 原子的キャッシュ更新のための一時ファイルパス生成
     * キャッシュファイルの書き込み中に他のプロセスが読み込むことを防ぐ
     */
    const tmpPath = cachePath ? cachePath + `.tmp-${crypto.randomBytes(6).toString("hex")}` : null;
    let transformer; // Sharp変換パイプライン

    try {
      /**
       * Sharpライブラリによる画像変換パイプライン構築
       * limitInputPixels: 1e8 (100Mピクセル) - メモリ保護のための入力制限
       *
       * 技術的詳細:
       * - limitInputPixels: 巨大画像によるメモリ枯渇を防止
       * - パイプライン構築: 複数の変換処理を効率的に連結
       * - ストリーミング: メモリ効率的な画像処理
       * - エラーハンドリング: 変換失敗時の適切な処理
       */
      transformer = sharp(fullPath, { limitInputPixels: 1e8 }); // 100Mピクセル制限

      // 回転補正は高速版では行わない（パフォーマンス優先）
      if (!isFast) transformer = transformer.rotate(); // EXIFに基づく自動回転

      /**
       * リサイズ処理の設定
       * Photo_Size が指定されている場合のみリサイズを実行
       *
       * 技術的詳細:
       * - 軽量版: 幅基準の単純リサイズ（処理速度優先）
       * - 通常版: 縦横比較による最適リサイズ（見た目優先）
       * - withoutEnlargement: 元画像より大きくしない制限
       * - メタデータ取得: 画像サイズ情報の動的取得
       */
      if (Photo_Size) {
        if (isFast) {
          // 軽量版: 幅を基準に単純リサイズ（処理速度優先）
          transformer = transformer.resize({
            width: Photo_Size, // 指定幅にリサイズ
            withoutEnlargement: true, // 元画像より大きくしない
          });
        } else {
          // 通常版: 縦横を比較して短辺に合わせる（見た目優先）
          const meta = await transformer.metadata(); // メタデータ取得
          if (meta.width != null && meta.height != null) { // サイズ情報が取得できた場合のみ
            if (meta.width < meta.height) { // 短辺が幅の場合
              transformer = transformer.resize({
                width: Photo_Size, // 指定幅にリサイズ
                withoutEnlargement: true, // 元画像より大きくしない
              });
            } else {
              transformer = transformer.resize({ // heightを基準にリサイズ
                height: Photo_Size, // 指定高さにリサイズ
                withoutEnlargement: true, // 元画像より大きくしない
              });
            }
          }
        }
      }

      /**
       * WebP出力設定
       * 品質と処理速度のバランスを調整
       *
       * 技術的詳細:
       * - quality: 圧縮品質（30-90の範囲）
       * - effort: 圧縮努力レベル（0=高速、1=標準）
       * - nearLossless: 準可逆圧縮の無効化
       * - smartSubsample: スマートサブサンプリングの有効/無効
       */
      transformer = transformer.webp({
        quality, // 品質設定（30-90）
        effort: isFast ? 0 : 1, // 圧縮努力レベル（0=高速、1=標準）
        nearLossless: false, // 準可逆圧縮は無効
        smartSubsample: isFast ? false : true, // スマートサブサンプリング
      });

      logger.info(`[変換実行][${label}] ${displayPath} → ${cachePath ?? "(no cache)"} (q=${quality})`); // 変換実行ログを出力

      /**
       * ストリーミング処理の設定
       * PassThroughストリームを使用して、同じデータをキャッシュ書き込みとレスポンス送信の両方に分岐
       *
       * 技術的詳細:
       * - PassThrough: データの複製なしで複数出力先への分岐
       * - メモリ効率: 大容量画像でもメモリ使用量を抑制
       * - 並列処理: キャッシュ書き込みとレスポンス送信の同時実行
       * - エラー伝播: ストリーム間のエラー状態の適切な伝播
       */
      const pass = new PassThrough(); // PassThroughストリーム
      transformer.pipe(pass); // Sharpの出力をPassThroughにパイプ

      let wroteHeader = false; // HTTPヘッダー送信フラグ

      /**
       * Sharp失敗時のフォールバック処理（ImageMagick使用）
       * Sharpで処理できない画像形式や破損ファイルに対応
       *
       * @param {Error} err - Sharp処理で発生したエラー
       */
      const onErrorFallback = (err) => {
        logger.warn(`[Sharp失敗→ImageMagick][${label}] ${displayPath} : ${err && err.message ? err.message : err}`); // 警告ログを出力

        // 一時ファイルの掃除（あれば）
        if (tmpPath) fs.unlink(tmpPath, () => {}); // 存在しない場合は無視

        /**
         * ImageMagickコマンドライン引数の構築
         * - resize: Photo_Sizeが指定されている場合のみリサイズ
         * - quality: WebP品質設定
         * - webp:-: 標準出力にWebP形式で出力
         *
         * 技術的詳細:
         * - spawn使用: ストリーミング処理によるメモリ効率化
         * - 標準出力: パイプによるデータ転送
         * - エラーハンドリング: プロセス失敗時の適切な処理
         * - リソース管理: プロセス終了時の自動クリーンアップ
         */
        const resizeOpt = Photo_Size ? ["-resize", `${Photo_Size}x${Photo_Size}`] : []; // リサイズオプション
        const magick = spawn(MAGICK_CMD, [fullPath, ...resizeOpt, "-quality", `${quality}`, "webp:-"]); // ImageMagickプロセスを起動

        // ImageMagickプロセスのエラーハンドリング
        magick.on("error", (err) => {
          logger.error(`[ImageMagick変換失敗][${label}] ${fullPath}: ${err}`); // エラーログを出力
          if (!res.headersSent) res.writeHead(415); // サポートされていないメディアタイプ
          res.end("Unsupported image format (sharp+magick error)"); // エラーメッセージを返す
          return reject(err); // 呼び出し元にエラーを伝播
        });

        // HTTPヘッダー設定（まだ送信されていない場合）
        if (!res.headersSent) {
          res.setHeader("Content-Type", "image/webp"); // WebP画像のMIMEタイプ
        }

        if (tmpPath) {
          // キャッシュファイルへの書き込み処理
          const writeStream = fs.createWriteStream(tmpPath); // 一時ファイルへの書き込みストリーム

          // ImageMagickの標準出力を一時ファイルとレスポンスの両方にストリーミング
          pipeline(magick.stdout, writeStream).catch((e) => logger.error("[magick->tmp pipeline error]", e));
          magick.stdout.pipe(res, { end: false }); // レスポンスは手動で終了

          // 書き込み完了時に原子的にリネーム
          writeStream.on("finish", () => {
            try {
              fs.renameSync(tmpPath, cachePath); // 原子的にリネーム
            } catch (e) {
              // リネーム失敗は無視（競合状態の可能性）
            }
          });
        } else {
          // キャッシュなしの場合は直接レスポンスにストリーミング
          pipeline(magick.stdout, res).catch((e) => logger.error("[magick->res pipeline error]", e)); // レスポンスはパイプラインで自動終了
        }

        // 変換完了時の処理
        magick.stdout.on("end", () => {
          logger.info(`[変換完了(fallback)][${label}] ${displayPath}`); // 変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });
      };

      // エラーハンドリングの設定
      transformer.on("error", onErrorFallback); // Sharp変換エラー時にフォールバック
      pass.on("error", onErrorFallback); // PassThroughエラー時にフォールバック

      /**
       * キャッシュ処理の分岐
       * キャッシュファイルが指定されている場合は原子的更新を実行
       *
       * 技術的詳細:
       * - 原子的更新: 一時ファイル→リネームによる整合性保証
       * - 競合回避: 複数プロセスによる同時書き込みの防止
       * - エラー回復: 書き込み失敗時の適切なクリーンアップ
       * - ストリーミング: データ受信と同時のキャッシュ書き込み
       */
      if (tmpPath) {
        const writeStream = fs.createWriteStream(tmpPath); // 一時ファイルへの書き込みストリーム
        let wroteAny = false; // データ書き込みフラグ

        // データ受信時の処理
        pass.on("data", (chunk) => {
          if (!wroteHeader) {
            // 最初のチャンク受信時にHTTPヘッダー送信（チャンク転送）
            res.writeHead(200, {
              "Content-Type": "image/webp", // WebP画像のMIMEタイプ
              Connection: "Keep-Alive", // Keep-Alive接続
              "Keep-Alive": "timeout=600", // Keep-Aliveタイムアウト
            });
            wroteHeader = true; // ヘッダー送信フラグを設定
          }
          wroteAny = true; // データが書き込まれたことを記録
        });

        // ストリーミング処理の設定（エラーハンドリング付き）
        pipeline(pass, writeStream).catch((e) => logger.error("[cache write pipeline error]", e)); // キャッシュ書き込み
        pipeline(pass, res).catch((e) => logger.error("[response pipeline error]", e)); // レスポンス送信

        // ストリーム終了時の処理
        pass.on("end", async () => {
          // 原子的キャッシュ更新処理
          if (wroteAny) {
            try {
              await fs.promises.rename(tmpPath, cachePath).catch(async (e) => { // 一時ファイルをキャッシュファイルにリネーム
                logger.warn("[cache rename error async]", e); // リネーム失敗は警告ログを出力
                // リネーム失敗時は一時ファイルを削除
                try {
                  await fs.promises.unlink(tmpPath).catch(() => {}); // 存在しない場合は無視
                } catch (_) {}
              });
            } catch (e) {
              logger.warn("[cache rename outer error]", e); // リネーム失敗は警告ログを出力
            }
          } else {
            // データが書き込まれていない場合は一時ファイルを削除
            try {
              await fs.promises.unlink(tmpPath).catch(() => {}); // 存在しない場合は無視
            } catch (_) {}
          }

          logger.info(`[変換完了][${label}] ${displayPath}`); // 変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });
      } else {
        /**
         * キャッシュなしの場合の処理
         * 直接レスポンスにストリーミング
         */
        pass.once("data", () => {
          if (!wroteHeader) { // 最初のチャンク受信時にHTTPヘッダー送信（チャンク転送）
            res.writeHead(200, { // レスポンスヘッダーを設定
              "Content-Type": "image/webp", // WebP画像のMIMEタイプ
              Connection: "Keep-Alive", // Keep-Alive接続
              "Keep-Alive": "timeout=600", // Keep-Aliveタイムアウト
            });
            wroteHeader = true; // ヘッダー送信フラグを設定
          }
        });

        pipeline(pass, res).catch((e) => logger.error("[response pipeline error]", e)); // レスポンス送信

        // ストリーム終了時の処理

        pass.on("end", () => {
          logger.info(`[変換完了][${label}] ${fullPath}`); // 変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });
      }
    } catch (e) {
      /**
       * Sharp初期化エラー時のフォールバック処理
       * Sharpライブラリの初期化やパイプライン構築で例外が発生した場合の処理
       */
      logger.warn("[sharp init error]", e); // 警告ログを出力

      // 一時ファイルの掃除（あれば）
      if (tmpPath) {
        try {
          fs.promises.unlink(tmpPath).catch(() => {}); // 存在しない場合は無視
        } catch (e) {}
      }

      // ImageMagickによるフォールバック処理
      const resizeOpt = Photo_Size ? ["-resize", `${Photo_Size}x${Photo_Size}`] : []; // リサイズオプション
      const magick = spawn(MAGICK_CMD, [fullPath, ...resizeOpt, "-quality", `${quality}`, "webp:-"]); // ImageMagickプロセスを起動

      // ImageMagickプロセスのエラーハンドリング
      magick.on("error", (err) => {
        logger.error(`[ImageMagick変換失敗][${label}] ${displayPath}: ${err}`); // エラーログを出力
        if (!res.headersSent) res.writeHead(415); // サポートされていないメディアタイプ
        res.end("Unsupported image format (sharp+magick error)"); // エラーメッセージを返す
        return reject(err); // 呼び出し元にエラーを伝播
      });

      // HTTPヘッダー設定
      if (!res.headersSent) res.setHeader("Content-Type", "image/webp"); // ヘッダー送信

      if (tmpPath) {
        // キャッシュファイルへの書き込み処理
        const writeStream = fs.createWriteStream(tmpPath); // 一時ファイルに書き込み

        // ImageMagickの標準出力を一時ファイルとレスポンスの両方にストリーミング
        pipeline(magick.stdout, writeStream).catch((e) => logger.error("[magick->tmp pipeline error]", e)); // キャッシュ書き込み
        magick.stdout.pipe(res, { end: false }); // レスポンスは手動で終了

        // 書き込み完了時の原子的リネーム処理
        writeStream.on("finish", async () => {
          try {
            await fs.promises.rename(tmpPath, cachePath).catch(() => {}); // リネーム失敗は無視（競合状態の可能性）
          } catch (e) {}
        });
      } else {
        // キャッシュなしの場合は直接レスポンスにストリーミング
        pipeline(magick.stdout, res).catch((e) => logger.error("[magick->res pipeline error]", e)); // レスポンスはパイプラインで自動終了
      }

      // 変換完了時の処理
      magick.stdout.on("end", () => {
        logger.info(`[変換完了(fallback)][${label}] ${displayPath}`); // 変換完了ログを出力
        res.end(); // レスポンス終了
        return resolve(); // 成功
      });
    }
  });
}
