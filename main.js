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

// 設定ファイル監視と動的設定更新機能
const CONFIG_FILE = path.join(__dirname, "config.txt");
const CONFIG_WATCH_INTERVAL = 10000; // 10秒間隔で設定ファイルを監視（より迅速な変更検出）

// 前回の設定値を保存するオブジェクト
let lastConfigValues = {};

/**
 * 設定値の検証関数
 * 各パラメータの入力規則をチェックし、不正な値の場合は既存値またはデフォルト値で代用
 */
function validateConfigValue(key, value, defaultValue) {
  // 数値型の設定検証
  if (key.includes('SIZE') || key.includes('LIST') || key.includes('MS') || key.includes('QUALITY') || 
      key.includes('CONCURRENCY') || key.includes('MEMORY') || key.includes('PIXEL') || key.includes('REQUESTS') || 
      key.includes('WINDOW') || key.includes('QUEUE') || key.includes('TIMEOUT') || key.includes('ACTIVE') ||
      key.includes('THRESHOLD')) {

    const numValue = parseInt(value);

    // 基本的な数値チェック
    if (isNaN(numValue) || numValue < 0) {
      logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (数値が無効)`);
      return defaultValue;
    }

    // 具体的な範囲チェック
    switch (key) {
      case 'DEFAULT_QUALITY':
        if (numValue < 10 || numValue > 100) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (品質は10-100の範囲)`);
          return defaultValue;
        }
        break;
      case 'PHOTO_SIZE':
        if (numValue < 100 || numValue > 8192) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (サイズは100-8192の範囲)`);
          return defaultValue;
        }
        break;
      case 'MAX_CONCURRENCY':
        if (numValue < 1 || numValue > 32) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (並列数は1-32の範囲)`);
          return defaultValue;
        }
        break;
      case 'SHARP_MEMORY_LIMIT':
        if (numValue < 16 || numValue > 4096) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (メモリ制限は16-4096MBの範囲)`);
          return defaultValue;
        }
        break;
      case 'SHARP_PIXEL_LIMIT':
        if (numValue < 1000000 || numValue > 1000000000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (ピクセル制限は1M-1000Mの範囲)`);
          return defaultValue;
        }
        break;
      case 'CACHE_TTL_MS':
        if (numValue < 60000 || numValue > 86400000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (キャッシュTTLは1分-24時間の範囲)`);
          return defaultValue;
        }
        break;
      case 'CACHE_MIN_SIZE':
        if (numValue < 1024 || numValue > 104857600) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (最小サイズは1KB-100MBの範囲)`);
          return defaultValue;
        }
        break;
      case 'RATE_LIMIT_REQUESTS':
        if (numValue < 1 || numValue > 1000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (リクエスト制限は1-1000の範囲)`);
          return defaultValue;
        }
        break;
      case 'RATE_LIMIT_WINDOW_MS':
        if (numValue < 1000 || numValue > 300000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (時間窓は1秒-5分の範囲)`);
          return defaultValue;
        }
        break;
      case 'RATE_LIMIT_QUEUE_SIZE':
        if (numValue < 10 || numValue > 1000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (キューサイズは10-1000の範囲)`);
          return defaultValue;
        }
        break;
      case 'STACK_MAX_SIZE':
        if (numValue < 50 || numValue > 500) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (スタックサイズは50-500の範囲)`);
          return defaultValue;
        }
        break;
      case 'STACK_PROCESSING_DELAY_MS':
        if (numValue < 1 || numValue > 100) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (処理遅延は1-100msの範囲)`);
          return defaultValue;
        }
        break;
      case 'MAX_LIST':
        if (numValue < 10 || numValue > 10000) {
          logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (リスト制限は10-10000の範囲)`);
          return defaultValue;
        }
        break;
    }

    return numValue;
  }

  // 真偽値型の設定検証
  if (key.includes('ENABLED')) {
    const lowerValue = value.toLowerCase();
    if (lowerValue !== 'true' && lowerValue !== 'false') {
      logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (真偽値はtrue/false)`);
      return defaultValue;
    }
    return lowerValue === 'true';
  }

  // 浮動小数点型の設定検証
  if (key.includes('THRESHOLD')) {
    const floatValue = parseFloat(value);
    if (isNaN(floatValue) || floatValue < 0 || floatValue > 1) {
      logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (閾値は0.0-1.0の範囲)`);
      return defaultValue;
    }
    return floatValue;
  }

  // 時刻形式の設定検証
  if (key === 'RESTART_TIME') {
    const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timePattern.test(value)) {
      logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (時刻形式はHH:MM)`);
      return defaultValue;
    }
    return value;
  }

  // パス形式の設定検証
  if (key === 'MAGICK_PATH') {
    if (typeof value !== 'string' || value.trim() === '') {
      logger.warn(`[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (パスが無効)`);
      return defaultValue;
    }
    return value.trim();
  }

  return value;
}

/**
 * 動的設定読み込み関数
 * config.txtから設定を読み込み、環境変数を動的に更新
 */
function getDynamicConfig(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined) return defaultValue;

  // 設定値の検証を実行
  const validatedValue = validateConfigValue(key, value, defaultValue);

  // デバッグ用ログ（型変換の確認）- 初回のみ出力
  if (key === 'SHARP_PIXEL_LIMIT' && !global.sharpPixelLimitLogged) {
    logger.info(`[設定デバッグ] ${key}: "${value}" (型: ${typeof value}) → ${validatedValue} (型: ${typeof validatedValue})`);
    global.sharpPixelLimitLogged = true;
  }

  return validatedValue;
}

/**
 * 設定ファイル読み込み関数
 * config.txtから設定を読み込み、環境変数を動的に更新（差分のみログ出力）
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configContent = fs.readFileSync(CONFIG_FILE, 'utf8');
      const lines = configContent.split('\n');
      let updatedCount = 0;
      const currentConfigValues = {};

      // 現在の設定値を読み込み
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, value] = trimmed.split('=');
          if (key && value !== undefined) {
            const keyTrimmed = key.trim();
            const valueTrimmed = value.trim();
            currentConfigValues[keyTrimmed] = valueTrimmed;
          }
        }
      }

      // 前回の設定値と比較して差分を検出
      for (const [key, value] of Object.entries(currentConfigValues)) {
            // 値が変更された場合のみ更新
            if (lastConfigValues[key] !== value) {
              // 環境変数には文字列として保存（getDynamicConfigで適切に型変換）
              process.env[key] = value;
              if (lastConfigValues[key] !== undefined) {
                // 既存設定の変更
                logger.info(`[設定変更] ${key}: ${lastConfigValues[key]} → ${value}`);

            // 重要な設定変更の場合は追加情報を出力
            if (key === 'DEFAULT_QUALITY') {
              logger.info(`[品質設定更新] 画像変換のデフォルト品質が ${value}% に変更されました`);
            } else if (key === 'COMPRESSION_THRESHOLD') {
              logger.info(`[圧縮設定更新] 圧縮閾値が ${(parseFloat(value) * 100).toFixed(1)}% に変更されました`);
            } else if (key === 'COMPRESSION_ENABLED') {
              logger.info(`[圧縮設定更新] 圧縮機能が ${value === 'true' ? '有効' : '無効'} に変更されました`);
            } else if (key === 'PHOTO_SIZE') {
              logger.info(`[画像サイズ設定更新] 画像リサイズサイズが ${value}px に変更されました`);
            } else if (key === 'MAX_LIST') {
              logger.info(`[リスト設定更新] 最大リスト数が ${value}件 に変更されました`);
            } else if (key === 'CACHE_TTL_MS') {
              logger.info(`[キャッシュ設定更新] キャッシュ有効期間が ${Math.floor(parseInt(value) / 1000)}秒 に変更されました`);
            } else if (key === 'CACHE_MIN_SIZE') {
              logger.info(`[キャッシュ設定更新] キャッシュ最小サイズが ${Math.floor(parseInt(value) / 1024)}KB に変更されました`);
            } else if (key === 'MAX_CONCURRENCY') {
              logger.info(`[並列処理設定更新] 最大並列数が ${value} に変更されました`);
            } else if (key === 'SHARP_MEMORY_LIMIT') {
              logger.info(`[Sharp設定更新] メモリキャッシュ制限が ${value}MB に変更されました`);
            } else if (key === 'SHARP_PIXEL_LIMIT') {
              logger.info(`[Sharp設定更新] ピクセル制限が ${parseInt(value).toLocaleString()} に変更されました`);
            } else if (key === 'RATE_LIMIT_ENABLED') {
              logger.info(`[レート制限設定更新] レート制限が ${value === 'true' ? '有効' : '無効'} に変更されました`);
            } else if (key === 'RATE_LIMIT_REQUESTS') {
              logger.info(`[レート制限設定更新] 1分間あたりのリクエスト数が ${value} に変更されました`);
            } else if (key === 'RATE_LIMIT_WINDOW_MS') {
              logger.info(`[レート制限設定更新] 時間窓が ${value}ms に変更されました`);
            } else if (key === 'RATE_LIMIT_QUEUE_SIZE') {
              logger.info(`[レート制限設定更新] キューサイズ制限が ${value} に変更されました`);
            } else if (key === 'EMERGENCY_DISABLE_RATE_LIMIT') {
              logger.warn(`[緊急時設定更新] レート制限が ${value === 'true' ? '無効化' : '有効'} に変更されました`);
            } else if (key === 'MAX_ACTIVE_REQUESTS') {
              logger.info(`[過負荷対策設定更新] 最大同時リクエスト数が ${value} に変更されました`);
            } else if (key === 'REQUEST_TIMEOUT_MS') {
              logger.info(`[過負荷対策設定更新] リクエストタイムアウトが ${value}ms に変更されました`);
            } else if (key === 'DROP_REQUESTS_WHEN_OVERLOADED') {
              logger.warn(`[過負荷対策設定更新] 過負荷時のリクエスト破棄が ${value === 'true' ? '有効' : '無効'} に変更されました`);
            } else if (key === 'AGGRESSIVE_DROP_ENABLED') {
              logger.warn(`[積極的破棄設定更新] 積極的破棄が ${value === 'true' ? '有効' : '無効'} に変更されました`);
            } else if (key === 'AGGRESSIVE_DROP_THRESHOLD') {
              logger.info(`[積極的破棄設定更新] 破棄閾値が ${value} リクエストに変更されました`);
            } else if (key === 'AGGRESSIVE_DROP_WINDOW_MS') {
              logger.info(`[積極的破棄設定更新] 時間窓が ${value}ms に変更されました`);
            } else if (key === 'EMERGENCY_RESET_ENABLED') {
              logger.warn(`[緊急リセット設定更新] 緊急リセットが ${value === 'true' ? '有効' : '無効'} に変更されました`);
            } else if (key === 'EMERGENCY_RESET_THRESHOLD') {
              logger.info(`[緊急リセット設定更新] リセット閾値が ${value} リクエストに変更されました`);
            } else if (key === 'EMERGENCY_RESET_WINDOW_MS') {
              logger.info(`[緊急リセット設定更新] リセット時間窓が ${value}ms に変更されました`);
            }
              } else {
                // 新規設定の追加
                logger.info(`[設定追加] ${key}=${value}`);
              }
              updatedCount++;
            }
      }

      // 削除された設定を検出
      for (const [key, value] of Object.entries(lastConfigValues)) {
        if (currentConfigValues[key] === undefined) {
          logger.info(`[設定削除] ${key}=${value}`);
          updatedCount++;
        }
      }

      // 前回の設定値を更新
      lastConfigValues = { ...currentConfigValues };

      // 変更があった場合のみサマリーログを出力
      if (updatedCount > 0) {
        logger.info(`[設定監視] ${updatedCount}個の設定を更新しました`);

        // Sharp関連の設定が変更された場合はSharpの設定を再適用
        const sharpRelatedKeys = ['MAX_CONCURRENCY', 'SHARP_MEMORY_LIMIT', 'SHARP_PIXEL_LIMIT'];
        const hasSharpChanges = Object.keys(currentConfigValues).some(key => 
          sharpRelatedKeys.includes(key) && 
          lastConfigValues[key] !== currentConfigValues[key]
        );
        if (hasSharpChanges) {
          configureSharp();
        }
      }
    } else {
      // ファイルが見つからない場合のみ警告（初回以外は抑制）
      if (Object.keys(lastConfigValues).length > 0) {
        logger.warn(`[設定監視] 設定ファイルが見つかりません: ${CONFIG_FILE}`);
      }
    }
  } catch (error) {
    logger.warn(`[設定読み込みエラー] ${error.message}`);
  }
}

// 初期設定読み込み
loadConfig();

// 設定ファイル監視開始
setInterval(loadConfig, CONFIG_WATCH_INTERVAL);
logger.info(`[設定監視開始] ${CONFIG_FILE} を ${CONFIG_WATCH_INTERVAL/1000}秒間隔で監視中`);

// 圧縮機能の有効/無効制御（動的設定対応）
function getCompressionEnabled() {
  return process.env.COMPRESSION_ENABLED !== "false";
}

function getCompressionThreshold() {
  return parseFloat(process.env.COMPRESSION_THRESHOLD) || 0.3;
}

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
// Sharpの初期設定は動的設定読み込み後に実行（関数定義は後で行う）

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
// キャッシュディレクトリの設定（権限問題対応）
let CACHE_DIR = "Y:/caches/webdav/tmp"; // キャッシュファイル保存ディレクトリ
const FALLBACK_CACHE_DIR = path.join(__dirname, "cache"); // 代替キャッシュディレクトリ
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分 - キャッシュクリーニング実行間隔

// 動的キャッシュ設定読み込み関数
const getCacheMinSize = () => getDynamicConfig('CACHE_MIN_SIZE', 1 * 1024 * 1024); // 1MB - キャッシュ対象の最小ファイルサイズ
const getCacheTTL = () => getDynamicConfig('CACHE_TTL_MS', 5 * 60 * 1000); // 5分 - キャッシュファイルの有効期間

  // メモリ管理設定読み込み関数
  const getMaxConcurrency = () => getDynamicConfig('MAX_CONCURRENCY', 2); // 最大並列処理数（大量アクセス対策）
  const getSharpMemoryLimit = () => getDynamicConfig('SHARP_MEMORY_LIMIT', 64); // Sharpメモリキャッシュ制限（MB）
  const getSharpPixelLimit = () => getDynamicConfig('SHARP_PIXEL_LIMIT', 10000000); // Sharpピクセル制限

  // レート制限設定読み込み関数
  const getRateLimitEnabled = () => {
    const emergencyDisable = getDynamicConfig('EMERGENCY_DISABLE_RATE_LIMIT', false);
    if (emergencyDisable) return false; // 緊急時は無効化
    return getDynamicConfig('RATE_LIMIT_ENABLED', true);
  };
  const getRateLimitRequests = () => getDynamicConfig('RATE_LIMIT_REQUESTS', 50); // 1分間あたりのリクエスト数
  const getRateLimitWindow = () => getDynamicConfig('RATE_LIMIT_WINDOW_MS', 60000); // 時間窓（ミリ秒）
  const getRateLimitQueueSize = () => getDynamicConfig('RATE_LIMIT_QUEUE_SIZE', 100); // キューサイズ制限

  // 過負荷対策設定読み込み関数
  const getMaxActiveRequests = () => getDynamicConfig('MAX_ACTIVE_REQUESTS', 10); // 最大同時リクエスト数
  const getRequestTimeout = () => getDynamicConfig('REQUEST_TIMEOUT_MS', 5000); // リクエストタイムアウト（ミリ秒）
  const getDropRequestsWhenOverloaded = () => getDynamicConfig('DROP_REQUESTS_WHEN_OVERLOADED', true); // 過負荷時のリクエスト破棄

  // 積極的破棄設定読み込み関数
  const getAggressiveDropEnabled = () => getDynamicConfig('AGGRESSIVE_DROP_ENABLED', true); // 積極的破棄有効
  const getAggressiveDropThreshold = () => getDynamicConfig('AGGRESSIVE_DROP_THRESHOLD', 20); // 破棄閾値（リクエスト数）
  const getAggressiveDropWindow = () => getDynamicConfig('AGGRESSIVE_DROP_WINDOW_MS', 3000); // 時間窓（ミリ秒）

  // 緊急リセット設定読み込み関数
  const getEmergencyResetEnabled = () => getDynamicConfig('EMERGENCY_RESET_ENABLED', true); // 緊急リセット有効
  const getEmergencyResetThreshold = () => getDynamicConfig('EMERGENCY_RESET_THRESHOLD', 15); // リセット閾値（リクエスト数）
  const getEmergencyResetWindow = () => getDynamicConfig('EMERGENCY_RESET_WINDOW_MS', 3000); // 時間窓（ミリ秒）

// Sharpの初期設定関数（動的設定関数の定義後に配置）
function configureSharp() {
  try {
    const cpuCount = Math.max(1, os.cpus().length - 1); // 最低1、最大はCPU数-1
    const maxConcurrency = getMaxConcurrency(); // 動的設定から取得
    const memoryLimit = getSharpMemoryLimit(); // 動的設定から取得

    // 動的設定を反映
    sharp.concurrency(maxConcurrency);
    sharp.cache({
      memory: memoryLimit, // 動的設定のメモリキャッシュサイズ（MB）
      files: 100, // ファイルキャッシュ数
      items: 200, // アイテムキャッシュ数
    });
    logger.info(`sharp configured: concurrency=${maxConcurrency}, memory=${memoryLimit}MB`);
  } catch (e) {
    logger.warn("failed to configure sharp performance settings", e);
  }
}

// Sharpの初期設定を実行
configureSharp();

  /**
   * リクエストスタッククラス
   * LIFO（Last In, First Out）方式でリクエストを処理
   * 最新のリクエスト（ユーザーが現在見ようとしている画像）を最優先で処理
   */
  class RequestStack {
    constructor() {
      this.stack = []; // リクエストスタック
      this.processing = false; // 処理中フラグ
      this.maxStackSize = 100; // スタックの最大サイズ
      this.processedCount = 0; // 処理済みリクエスト数
      this.lastProcessTime = Date.now(); // 最後の処理時刻
      this.stuckCheckInterval = null; // スタック監視のインターバル
      this.currentFolder = null; // 現在のフォルダパス
      this.folderChangeCount = 0; // フォルダ変更回数

      // スタック監視を開始（5秒間隔でチェック）
      this.startStuckMonitoring();
    }

  // リクエストをスタックに追加
  push(requestInfo) {
    // フォルダ変更検出
    const requestFolder = this.extractFolderFromPath(requestInfo.displayPath);
    if (this.currentFolder !== null && this.currentFolder !== requestFolder) {
      // フォルダが変更された場合はスタックをクリア
      this.clearStackForFolderChange(requestFolder);
    }
    this.currentFolder = requestFolder;

    // 積極的なスタックサイズ制限（50個で警告、80個で積極的破棄）
    if (this.stack.length >= 80) {
      // 80個以上の場合、古いリクエストを50%破棄
      const removeCount = Math.floor(this.stack.length * 0.5);
      for (let i = 0; i < removeCount; i++) {
        const removed = this.stack.shift();
        if (removed && removed.res && !removed.res.headersSent) {
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          removed.res.end('Request stack overflow. Please retry.');
        }
      }
      logger.warn(`[スタック積極的破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`);
    } else if (this.stack.length >= 50) {
      // 50個以上の場合、古いリクエストを25%破棄
      const removeCount = Math.floor(this.stack.length * 0.25);
      for (let i = 0; i < removeCount; i++) {
        const removed = this.stack.shift();
        if (removed && removed.res && !removed.res.headersSent) {
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          removed.res.end('Request stack overflow. Please retry.');
        }
      }
      logger.warn(`[スタック部分破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`);
    } else if (this.stack.length >= this.maxStackSize) {
      // 最大サイズの場合、古いリクエストを1件削除
      const removed = this.stack.shift();
      if (removed && removed.res && !removed.res.headersSent) {
        removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        removed.res.end('Request stack overflow. Please retry.');
      }
      logger.warn(`[スタックオーバーフロー] 古いリクエストを破棄: ${removed?.displayPath || 'unknown'}`);
    }

    // 新しいリクエストをスタックの最後に追加（LIFOのため最後が最優先）
    this.stack.push(requestInfo);
    logger.info(`[スタック追加] ${requestInfo.displayPath} (スタックサイズ: ${this.stack.length})`);

    // 処理を開始
    this.processNext();
  }

    // 次のリクエストを処理
    async processNext() {
      if (this.processing || this.stack.length === 0) {
        return; // 既に処理中またはスタックが空の場合は何もしない
      }

      this.processing = true;
      const requestInfo = this.stack.pop(); // スタックの最後から取得（最新のリクエスト）

      // タイムアウト設定（8秒でタイムアウト）
      const timeoutId = setTimeout(() => {
        logger.warn(`[スタック処理タイムアウト] ${requestInfo.displayPath} - 8秒でタイムアウト`);
        if (requestInfo.res && !requestInfo.res.headersSent) {
          requestInfo.res.writeHead(408, { 'Content-Type': 'text/plain; charset=utf-8' });
          requestInfo.res.end('Request timeout');
        }
        this.processing = false;
        // 次のリクエストを処理
        setTimeout(() => this.processNext(), 5);
      }, 8000);

      try {
        logger.info(`[スタック処理開始] ${requestInfo.displayPath} (残り: ${this.stack.length})`);

        // 最後の処理時刻を更新
        this.lastProcessTime = Date.now();

        // リクエスト処理を実行（タイムアウト付き）
        await Promise.race([
          requestInfo.processor(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Processor timeout')), 6000))
        ]);

        clearTimeout(timeoutId);
        this.processedCount++;
        this.lastProcessTime = Date.now(); // 完了時刻も更新
        logger.info(`[スタック処理完了] ${requestInfo.displayPath} (処理済み: ${this.processedCount})`);

      } catch (error) {
        clearTimeout(timeoutId);
        logger.error(`[スタック処理エラー] ${requestInfo.displayPath}: ${error.message}`);

        // エラー時は適切なレスポンスを送信
        if (requestInfo.res && !requestInfo.res.headersSent) {
          requestInfo.res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          requestInfo.res.end('Internal server error');
        }
      } finally {
        this.processing = false;

        // スタックに残りのリクエストがあれば次の処理を開始
        if (this.stack.length > 0) {
          // 次の処理を少し遅延させてCPU負荷を軽減
          setTimeout(() => this.processNext(), 5);
        }
      }
    }

  // スタック監視を開始
  startStuckMonitoring() {
    this.stuckCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastProcess = now - this.lastProcessTime;

      // 処理中で5秒以上経過している場合は強制復旧（より積極的）
      if (this.processing && timeSinceLastProcess > 5000) {
        logger.warn(`[スタック強制復旧] 処理が5秒以上停止しています - 強制復旧を実行`);
        this.forceRecovery();
      }

      // スタックが30個以上溜まっている場合は警告
      if (this.stack.length > 30) {
        logger.warn(`[スタック警告] スタックが${this.stack.length}個に達しています`);
      }

      // スタックが60個以上溜まっている場合は積極的破棄
      if (this.stack.length > 60) {
        const removeCount = Math.floor(this.stack.length * 0.3); // 30%破棄
        for (let i = 0; i < removeCount; i++) {
          const removed = this.stack.shift();
          if (removed && removed.res && !removed.res.headersSent) {
            removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            removed.res.end('Request stack emergency clear. Please retry.');
          }
        }
        logger.warn(`[スタック緊急破棄] ${removeCount}件のリクエストを破棄 (残り: ${this.stack.length})`);
        this.forceRecovery();
      }

      // スタックが100個以上溜まっている場合は強制復旧
      if (this.stack.length > 100) {
        logger.warn(`[スタック緊急復旧] スタックが${this.stack.length}個に達しています - 緊急復旧を実行`);
        this.forceRecovery();
      }
    }, 3000); // 3秒間隔でチェック（より頻繁に監視）
  }

    // 強制復旧処理
    forceRecovery() {
      logger.error(`[スタック強制復旧実行] 処理中フラグをリセット`);
      this.processing = false;
      this.lastProcessTime = Date.now();

      // 次のリクエストを処理
      setTimeout(() => this.processNext(), 100);
    }

    // スタックの状態を取得
    getStatus() {
      return {
        stackSize: this.stack.length,
        processing: this.processing,
        processedCount: this.processedCount,
        maxStackSize: this.maxStackSize,
        timeSinceLastProcess: Date.now() - this.lastProcessTime,
        currentFolder: this.currentFolder,
        folderChangeCount: this.folderChangeCount
      };
    }

    // パスからフォルダを抽出
    extractFolderFromPath(displayPath) {
      // パスからフォルダ部分を抽出
      const pathParts = displayPath.split('/');
      if (pathParts.length <= 2) {
        return displayPath; // ルートレベルの場合
      }
      // 最後の要素（ファイル名）を除いた部分をフォルダパスとする
      return pathParts.slice(0, -1).join('/');
    }

    // フォルダ変更時のスタッククリア
    clearStackForFolderChange(newFolder) {
      this.folderChangeCount++;
      const clearedCount = this.stack.length;

      // スタック内のすべてのリクエストにエラーレスポンスを送信
      this.stack.forEach(requestInfo => {
        if (requestInfo.res && !requestInfo.res.headersSent) {
          requestInfo.res.writeHead(410, { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache'
          });
          requestInfo.res.end('Request cancelled due to folder change');
        }
      });

      // スタックをクリア
      this.stack = [];

      // 処理中フラグをリセット
      this.processing = false;

      logger.info(`[フォルダ変更検出] "${this.currentFolder}" → "${newFolder}" - ${clearedCount}件のリクエストを破棄 (変更回数: ${this.folderChangeCount})`);
    }

    // スタック監視を停止
    stopMonitoring() {
      if (this.stuckCheckInterval) {
        clearInterval(this.stuckCheckInterval);
        this.stuckCheckInterval = null;
      }
    }
  }

  const requestStack = new RequestStack();

  /**
   * シンプルなサーバー監視クラス
   * スタック処理システム用の軽量な監視機能
   */
  class SimpleServerMonitor {
    constructor() {
      this.requestCount = 0;
      this.lastLogTime = Date.now();
    }

    // リクエスト開始（スタック処理では単純にカウントのみ）
    startRequest() {
      this.requestCount++;
      return `request-${this.requestCount}`;
    }

    // リクエスト終了（スタック処理では単純にカウントのみ）
    endRequest() {
      // 定期的にスタック状況をログ
      const now = Date.now();
      if (now - this.lastLogTime > 30000) { // 30秒ごと
        const stackStatus = requestStack.getStatus();
        logger.info(`[サーバー状況] 総リクエスト: ${this.requestCount}, スタック: ${stackStatus.stackSize}/${stackStatus.maxStackSize}, 処理中: ${stackStatus.processing}, フォルダ: ${stackStatus.currentFolder || 'none'}, 変更回数: ${stackStatus.folderChangeCount}`);
        this.lastLogTime = now;
      }
    }

    // 負荷状況取得
    getLoadStatus() {
      const stackStatus = requestStack.getStatus();
      return {
        totalRequests: this.requestCount,
        stackSize: stackStatus.stackSize,
        processing: stackStatus.processing,
        processedCount: stackStatus.processedCount
      };
    }
  }

  const serverMonitor = new SimpleServerMonitor();

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
function initializeCacheDirectory() {
  // まずメインキャッシュディレクトリを試行
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      logger.info(`[キャッシュディレクトリ作成] ${CACHE_DIR}`);
    }
    // 書き込み権限テスト
    const testFile = path.join(CACHE_DIR, "test_write_permission.tmp");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
    logger.info(`[キャッシュディレクトリ権限確認] ${CACHE_DIR} - OK`);
    return CACHE_DIR;
  } catch (e) {
    logger.error(`[キャッシュディレクトリ作成/権限エラー] ${CACHE_DIR}: ${e.message}`);

    // 代替キャッシュディレクトリを使用
    try {
      if (!fs.existsSync(FALLBACK_CACHE_DIR)) {
        fs.mkdirSync(FALLBACK_CACHE_DIR, { recursive: true });
        logger.info(`[代替キャッシュディレクトリ作成] ${FALLBACK_CACHE_DIR}`);
      }
      // 書き込み権限テスト
      const testFile = path.join(FALLBACK_CACHE_DIR, "test_write_permission.tmp");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      logger.info(`[代替キャッシュディレクトリ権限確認] ${FALLBACK_CACHE_DIR} - OK`);
      CACHE_DIR = FALLBACK_CACHE_DIR; // グローバル変数を更新
      return FALLBACK_CACHE_DIR;
    } catch (fallbackError) {
      logger.error(`[代替キャッシュディレクトリも失敗] ${FALLBACK_CACHE_DIR}: ${fallbackError.message}`);
      logger.warn("[キャッシュ機能を無効化] すべてのキャッシュディレクトリで書き込み権限なし");
      return null; // キャッシュ無効化
    }
  }
}

const activeCacheDir = initializeCacheDirectory();
if (activeCacheDir) {
  logger.info("=== キャッシュリセット中... ===");
  resetCacheSync(activeCacheDir);
  logger.info("=== キャッシュリセット完了 ===");
} else {
  logger.warn("=== キャッシュ機能が無効化されました ===");
}

/**
 * キャッシュディレクトリの定期クリーニング設定
 */

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
      if (stat && Date.now() - stat.mtimeMs > getCacheTTL()) {
        await fs.promises.unlink(full).catch(() => {}); // 削除失敗は無視
      }
    }
  }
}

// 定期クリーニングの開始（30分間隔で実行）- キャッシュディレクトリが有効な場合のみ
if (activeCacheDir) {
  setInterval(() => cleanupCache(activeCacheDir), CLEANUP_INTERVAL_MS);
  logger.info(`[定期クリーニング設定] ${activeCacheDir} を ${CLEANUP_INTERVAL_MS/1000}秒間隔で監視中`);
}

/**
 * 自動再起動機能
 * 特定時刻にプロセスを再起動してメモリリークやリソース問題を防止
 *
 * 設定方法:
 * - 環境変数 RESTART_TIME: "03:00" (24時間形式、日本時間)
 * - 環境変数 RESTART_ENABLED: "true" (再起動機能の有効/無効)
 *
 * 技術的詳細:
 * - 毎分チェック: 現在時刻が設定時刻と一致するかチェック
 * - グレースフルシャットダウン: 既存接続の完了を待ってから再起動
 * - ログ出力: 再起動予告と実行ログの記録
 */
const RESTART_ENABLED = process.env.RESTART_ENABLED === "true";
const RESTART_TIME = process.env.RESTART_TIME || "12:10"; // デフォルト: 午前3時

let restartScheduled = false; // 重複再起動防止フラグ

if (RESTART_ENABLED) {
  logger.info(`[再起動機能] 有効 - 再起動時刻: ${RESTART_TIME} (JST)`);

  // 毎分、再起動時刻をチェック
  setInterval(() => {
    const now = new Date();
    const jstTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const currentTime = jstTime.toTimeString().slice(0, 5); // "HH:MM"形式

    if (currentTime === RESTART_TIME && !restartScheduled) {
      restartScheduled = true;
      logger.info(`[再起動予告] 5分後に自動再起動を実行します (${currentTime})`);

      // 5分後に再起動を実行
      setTimeout(() => {
        logger.info("[再起動実行] 自動再起動を開始します...");

        // グレースフルシャットダウン: 既存の接続が完了するまで待機
        process.exit(0); // 正常終了（PM2等のプロセス管理ツールが自動再起動）
      }, 5 * 60 * 1000); // 5分 = 5 * 60 * 1000ms
    }

    // 再起動時刻を過ぎたらフラグをリセット（翌日の再起動準備）
    if (currentTime !== RESTART_TIME) {
      restartScheduled = false;
    }
  }, 60 * 1000); // 1分間隔でチェック
} else {
  logger.info("[再起動機能] 無効 (RESTART_ENABLED=false または未設定)");
}

/**
 * サーバー設定配列
 * 複数のWebDAVサーバーを異なる設定で同時起動するための設定定義
 * 各サーバーは用途に応じて最適化された設定を持つ
 */
const serverConfigs = [
  {
    PORT: 1900, // サーバーポート番号
    ROOT_PATH: "Z:/書籍", // WebDAVのルートディレクトリ
    MAX_LIST: 128 * 7, // ディレクトリリスト表示の最大件数（896件）
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
  // 設定の分割代入（動的設定読み込み対応）
  const { PORT, ROOT_PATH, label } = config;

  // 動的設定読み込み関数
  const getPhotoSize = () => getDynamicConfig('PHOTO_SIZE', config.Photo_Size);
  const getMaxList = () => getDynamicConfig('MAX_LIST', config.MAX_LIST);
  const getDefaultQuality = () => getDynamicConfig('DEFAULT_QUALITY', config.defaultQuality);

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
    max: 10000, // 最大10,000エントリ（ディレクトリリスト）- 大量画像フォルダでのメモリ不足を防ぐため削減
    ttl: DIR_TTL, // TTL: 1時間
  });

  const statCache = new LRUCache({
    max: 50000, // 最大50,000エントリ（ファイル統計情報）- 大量画像フォルダでのメモリ不足を防ぐため大幅削減
    ttl: STAT_TTL, // TTL: 1時間
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
    if (cached) return cached.slice(0, MAX_LIST); // キャッシュヒット時はMAX_LIST件まで返す

    let names = [];
    try {
      // opendirSyncを使用したストリーミング読み込み（大量ファイル対応）
      const dirHandle = fs.opendirSync(dir); // 同期opendir（Dirオブジェクトを返す）
      let entry;
      // MAX_LIST件まで読み込み（メモリ使用量制限）
      while ((entry = dirHandle.readSync()) !== null && names.length < getMaxList()) {
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
        if (!(lc === rr || lc.startsWith(rr + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
      } else {
        if (!(candidate === rootResolved || candidate.startsWith(rootResolved + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
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
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8'
      };
      return contentTypes[ext.toLowerCase()] || 'application/octet-stream';
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
      const requestId = serverMonitor.startRequest();

      // IPアドレス取得
      const clientIP = req.connection.remoteAddress || req.socket.remoteAddress ||
                      (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
                      req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';

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
       * 画像ファイルのGETリクエスト処理（スタック処理）
       * 画像拡張子を持つファイルへのアクセス時に変換処理をスタックに追加
       */
      if (req.method === "GET" && IMAGE_EXTS.includes(ext)) {
        logger.info(`[変換要求][${label}] ${fullPath}`); // 変換要求ログを出力

        // 画像変換処理をスタックに追加
        requestStack.push({
          displayPath,
          res,
          processor: async () => {
            const st = await statPWrap(fullPath).catch(() => null); // ファイルの情報を取得

            // ファイルが存在しない場合（ディレクトリやファイルでない場合）
            if (!st || !st.isFile()) {
              logger.warn(`[404 Not Found][${label}] ${fullPath}`); // 警告ログを出力
              res.writeHead(404); // Not Found
              return res.end("Not found"); // エラーメッセージを返す
            }

            // 画像サイズが1MB以上の場合のみキャッシュ
            const shouldCache = st.size >= getCacheMinSize(); // キャッシュを使用するかどうか

            /**
             * 品質パラメータの取得と検証
             * クエリパラメータから品質を取得し、30-90の範囲に制限
             * 設定ファイルから動的にデフォルト品質を取得
             */
            const qParam = req.url.match(/[?&]q=(\d+)/)?.[1]; // クエリからqualityを取得
            const quality = qParam
              ? Math.min(Math.max(parseInt(qParam, 10), 30), 90) // 30から90の範囲でqualityを取得
              : getDefaultQuality(); // 動的なデフォルト品質を使用

            /**
             * キャッシュキーの生成
             * ファイルパス、リサイズサイズ、品質、変更時間、ファイルサイズを含めて
             * ファイルの変更を検知し、適切なキャッシュ管理を実現
             */
            const key = crypto
              .createHash("md5") // MD5ハッシュアルゴリズムを使用
              .update(fullPath + "|" + (getPhotoSize() ?? "o") + "|" + quality + "|" + String(st.mtimeMs) + "|" + String(st.size)) // 複数パラメータを連結
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

            // 画像変換を実行
            await convertAndRespond({ 
              fullPath, 
              displayPath, 
              cachePath: shouldCache ? cachePath : null, 
              quality, 
              Photo_Size: getPhotoSize(), 
              label, 
              fs, 
              sharp, 
              execFile, 
              res, 
              clientIP 
            });
          }
        });

        // スタック処理なので即座にレスポンスを返さない（スタックで処理される）
        return;
      }

      /**
       * WebDAVリクエストの処理
       * 画像以外のファイルやディレクトリに対するWebDAV操作を処理
       */
      try {
        logger.info(`[WebDAV][${label}] ${req.method} ${displayPath}`); // WebDAVリクエストのログを出力

        // レスポンスオブジェクトの型チェック（WebDAVサーバーとの互換性確保）
        if (typeof res.setHeader === 'function') {
          res.setHeader("Connection", "Keep-Alive"); // Keep-Alive接続
          res.setHeader("Keep-Alive", "timeout=120"); // Keep-Aliveタイムアウト
          res.setHeader("Accept-Ranges", "bytes"); // バイトレンジリクエストをサポート
          res.setHeader("Cache-Control", "public, max-age=0, must-revalidate"); // キャッシュ制御ヘッダー
        }

        // WebDAVレスポンスの圧縮処理
        if (getCompressionEnabled() && typeof res.setHeader === 'function') {
          const acceptEncoding = req.headers['accept-encoding'] || '';
          const supportsGzip = acceptEncoding.includes('gzip');

          if (supportsGzip) {
            // レスポンスのラッパーを作成して圧縮処理を追加
            const originalWriteHead = res.writeHead;
            const originalWrite = res.write;
            const originalEnd = res.end;

            let responseData = [];
            let headersWritten = false;

            res.writeHead = function(statusCode, statusMessage, headers) {
              if (typeof statusCode === 'object') {
                headers = statusCode;
                statusCode = 200;
              }
              headers = headers || {};

              // Content-Typeを確認
              const contentType = headers['content-type'] || res.getHeader('content-type') || '';
              const isTextResponse = contentType.includes('xml') ||
                                    contentType.includes('html') ||
                                    contentType.includes('json') ||
                                    contentType.includes('text');

              if (isTextResponse) {
                // テキストレスポンスの場合は圧縮準備
                headers['Vary'] = 'Accept-Encoding';
              }

              headersWritten = true;
              return originalWriteHead.call(this, statusCode, statusMessage, headers);
            };

            res.write = function(chunk, encoding) {
              if (chunk) {
                responseData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
              }
              return true;
            };

            res.end = function(chunk, encoding) {
              // 既にレスポンスが終了している場合は何もしない
              if (res.headersSent && res.finished) {
                return;
              }

              if (chunk) {
                responseData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
              }

              if (responseData.length === 0) {
                return originalEnd.call(this);
              }

              const fullData = Buffer.concat(responseData);
              const contentType = res.getHeader('content-type') || '';
              const isTextResponse = contentType.includes('xml') ||
                                    contentType.includes('html') ||
                                    contentType.includes('json') ||
                                    contentType.includes('text');

              // 最小サイズ制限（1KB未満は圧縮しない）
              const MIN_COMPRESS_SIZE = 1024;
              if (!isTextResponse || fullData.length < MIN_COMPRESS_SIZE) {
                logger.info(`[圧縮スキップ][${label}] ${displayPath} - 条件未満: テキスト=${isTextResponse}, サイズ=${fullData.length}`);
                return originalEnd.call(this, fullData);
              }

              // 圧縮処理
              zlib.gzip(fullData, {
                level: 9,
                memLevel: 9,
                windowBits: 15
              }, (err, compressed) => {
                // 圧縮処理中にレスポンスが既に終了している場合は何もしない
                if (res.headersSent && res.finished) {
                  return;
                }

                if (err) {
                  logger.warn(`[圧縮エラー][${label}] ${displayPath}: ${err.message}`);
                  return originalEnd.call(this, fullData);
                }

                // 圧縮効果の確認
                const compressionRatio = compressed.length / fullData.length;
                const threshold = getCompressionThreshold();
                logger.info(`[圧縮結果][${label}] ${displayPath} - 圧縮率: ${(compressionRatio * 100).toFixed(1)}%, 閾値: ${(threshold * 100).toFixed(1)}%`);

                if (compressionRatio < threshold) {
                  // 圧縮レスポンスの送信
                  res.setHeader('Content-Encoding', 'gzip');
                  res.setHeader('Content-Length', compressed.length);

                  logger.info(`[圧縮適用][${label}] ${displayPath} サイズ: ${fullData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`);
                  originalEnd.call(this, compressed);
                } else {
                  logger.info(`[圧縮スキップ][${label}] ${displayPath} - 圧縮効果が不十分: ${(compressionRatio * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(1)}%`);
                  originalEnd.call(this, fullData);
                }
              });
            };
          }
        }

        // テキストファイルの圧縮処理（WebDAV処理の前）
        const textExts = ['.html', '.htm', '.css', '.js', '.json', '.xml', '.txt', '.md'];
        const isTextFile = textExts.includes(ext.toLowerCase());

        if (getCompressionEnabled() && req.method === 'GET' && isTextFile && typeof res.setHeader === 'function') {
          // 圧縮対応の確認
          const acceptEncoding = req.headers['accept-encoding'] || '';
          const supportsGzip = acceptEncoding.includes('gzip');

          if (supportsGzip) {
            try {
              // ファイルの存在確認
              const fileStat = await statPWrap(fullPath).catch(() => null);
              if (fileStat && fileStat.isFile() && fileStat.size > 1024) { // 1KB以上の場合のみ圧縮
                // ファイル読み込みと圧縮（高性能環境向け非同期処理）
                const fileData = await fs.promises.readFile(fullPath);
                const compressed = await new Promise((resolve, reject) => {
                  zlib.gzip(fileData, {
                    level: 9,        // 圧縮レベル（高品質圧縮、CPUリソースを最大活用）
                    memLevel: 9,     // メモリ使用量（64GB環境で最大メモリ使用）
                    windowBits: 15   // ウィンドウサイズ（最大32KB）
                  }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                  });
                });

                // 圧縮効果の確認（環境変数で閾値を制御可能）
                const compressionRatio = compressed.length / fileData.length;
                if (compressionRatio < getCompressionThreshold()) {
                  // 圧縮レスポンスの送信
                  res.writeHead(200, {
                    'Content-Type': getContentType(ext),
                    'Content-Encoding': 'gzip',
                    'Content-Length': compressed.length,
                    'Vary': 'Accept-Encoding'
                  });
                  res.end(compressed);
                  logger.info(`[ファイル圧縮完了][${label}] ${displayPath} サイズ: ${fileData.length} → ${compressed.length} bytes (圧縮率: ${(compressionRatio * 100).toFixed(1)}%)`);
                  return; // 圧縮レスポンスを送信して処理終了
                }
              }
            } catch (compressError) {
              logger.warn(`[ファイル圧縮エラー][${label}] ${displayPath}: ${compressError.message}`);
            }
          }
        }

        server.executeRequest(req, res); // WebDAVサーバーにリクエストを処理させる

        // WebDAVレスポンス終了時の処理
        res.on('close', () => {
          serverMonitor.endRequest();
        });
        res.on('finish', () => {
          serverMonitor.endRequest();
        });
      } catch (e) {
        logger.error("WebDAV error", e); // エラーログを出力
        serverMonitor.endRequest(); // エラー時も監視終了
        if (!res.headersSent && typeof res.writeHead === 'function') {
          res.writeHead(500); // Internal Server Error
          res.end("WebDAV error"); // エラーメッセージを返す
        } else if (typeof res.end === 'function') {
          res.end(); // 既にヘッダーが送信されている場合はレスポンスを終了
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
      logger.info(`[INFO] キャッシュDir=${CACHE_DIR} / MAX_LIST=${getMaxList()} / Photo_Size=${getPhotoSize() ?? "オリジナル"}`); // キャッシュ設定ログを出力
      logger.info(`[INFO] 圧縮機能=${getCompressionEnabled() ? "有効" : "無効"} / 圧縮閾値=${(getCompressionThreshold() * 100).toFixed(1)}%`); // 圧縮設定ログを出力
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
async function convertAndRespond({ fullPath, displayPath, cachePath, quality, Photo_Size, label, fs, sharp, execFile, res, clientIP }) {
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
      transformer = sharp(fullPath, { limitInputPixels: getSharpPixelLimit() }); // 動的設定によるピクセル制限（大量画像処理時のメモリ保護強化）

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

      // Sharp変換にタイムアウトを設定（5秒）
      const sharpTimeout = setTimeout(() => {
        logger.warn(`[Sharp変換タイムアウト] ${displayPath} - 5秒でタイムアウト`);
        transformer.destroy();
        onErrorFallback(new Error('Sharp conversion timeout'));
      }, 5000);

      // メモリ使用量の監視（大量画像処理時の診断用）- 初回のみ詳細ログ
      const memUsage = process.memoryUsage();
      const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const pixelLimit = getSharpPixelLimit();

      // 初回のみ詳細ログを出力
      if (!global.imageConversionLogged) {
        logger.info(`[変換実行][${label}] ${displayPath} → ${cachePath ?? "(no cache)"} (q=${quality}) [メモリ: ${memUsageMB}MB, ピクセル制限: ${pixelLimit} (型: ${typeof pixelLimit})]`);
        global.imageConversionLogged = true;
      } else {
        logger.info(`[変換実行][${label}] ${displayPath} → ${cachePath ?? "(no cache)"} (q=${quality})`);
      }

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
      let responseSize = 0; // レスポンスデータサイズ（バイト）

      /**
       * Sharp失敗時のフォールバック処理（ImageMagick使用）
       * Sharpで処理できない画像形式や破損ファイルに対応
       *
       * @param {Error} err - Sharp処理で発生したエラー
       */
      const onErrorFallback = (err) => {
        // より詳細なエラー情報を出力
        const errorMsg = err && err.message ? err.message : err;
        const errorCode = err && err.code ? err.code : 'unknown';

        if (errorMsg.includes('Premature close')) {
          logger.info(`[Sharp Premature close - スキップ] ${displayPath} : Premature close (ストリーム終了) - エラーコード: ${errorCode}`);
          // Premature closeエラーの場合は直接スキップ（ImageMagickフォールバックしない）
          if (res && !res.headersSent) {
            res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Request cancelled due to stream error');
          }
          return resolve();
        } else {
          logger.warn(`[Sharp失敗→ImageMagick][${label}] ${displayPath} : ${errorMsg} (エラーコード: ${errorCode})`);

          // 特定のエラーに対しては詳細情報を出力
          if (errorCode === 'ENOENT') {
            logger.error(`[Sharp失敗詳細] ファイルが見つかりません: ${fullPath}`);
          } else if (errorCode === 'EACCES') {
            logger.error(`[Sharp失敗詳細] ファイルアクセス権限がありません: ${fullPath}`);
          } else if (errorCode === 'EMFILE' || errorCode === 'ENFILE') {
            logger.error(`[Sharp失敗詳細] ファイルディスクリプタ不足: ${fullPath}`);
          } else if (errorMsg.includes('Input file is missing')) {
            logger.error(`[Sharp失敗詳細] 入力ファイルが存在しません: ${fullPath}`);
          } else if (errorMsg.includes('limitInputPixels')) {
            logger.error(`[Sharp失敗詳細] ピクセル制限超過: ${fullPath} (制限: ${getSharpPixelLimit()})`);
          }
        }

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

          // ImageMagick失敗時は元画像を直接送信
          logger.info(`[ImageMagick失敗→元画像送信][${label}] ${displayPath}`);

          // HTTPヘッダー設定（まだ送信されていない場合）
          if (!res.headersSent) {
            // 元画像のContent-Typeを設定
            const fileExt = path.extname(fullPath).toLowerCase();
            let contentType = 'application/octet-stream';
            if (fileExt === '.jpg' || fileExt === '.jpeg') contentType = 'image/jpeg';
            else if (fileExt === '.png') contentType = 'image/png';
            else if (fileExt === '.gif') contentType = 'image/gif';
            else if (fileExt === '.webp') contentType = 'image/webp';
            else if (fileExt === '.bmp') contentType = 'image/bmp';
            else if (fileExt === '.tiff' || fileExt === '.tif') contentType = 'image/tiff';

            res.setHeader("Content-Type", contentType);
          }

          // 元画像ファイルを直接ストリーミング
          const fileStream = fs.createReadStream(fullPath);
          fileStream.pipe(res);

          fileStream.on("error", (streamErr) => {
            logger.error(`[元画像送信失敗][${label}] ${displayPath}: ${streamErr.message}`);
            if (!res.headersSent) res.writeHead(500);
            res.end("Failed to read original image");
            return reject(streamErr);
          });

          fileStream.on("end", () => {
            logger.info(`[変換完了(元画像)][${label}] ${displayPath}`);
            res.end();
            return resolve();
          });
        });

        // HTTPヘッダー設定（まだ送信されていない場合）
        if (!res.headersSent) {
          res.setHeader("Content-Type", "image/webp"); // WebP画像のMIMEタイプ
        }

        if (tmpPath) {
        // キャッシュファイルへの書き込み処理（権限チェック付き）
        try {
          // 親ディレクトリの存在確認と作成
          const tmpDir = path.dirname(tmpPath);
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }

          const writeStream = fs.createWriteStream(tmpPath); // 一時ファイルへの書き込みストリーム

          // ImageMagickの標準出力を一時ファイルとレスポンスの両方にストリーミング
          pipeline(magick.stdout, writeStream).catch((e) => {
            // Premature closeエラーは頻発するため、ログレベルを調整
            if (e.message && e.message.includes('Premature close')) {
              logger.info(`[magick->tmp pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill('SIGTERM');
                  logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->tmp pipeline error] ${e.message}`);
            }
            // キャッシュ書き込み失敗時はキャッシュなしで続行
          });
          magick.stdout.pipe(res, { end: false }); // レスポンスは手動で終了

          // ImageMagickの標準出力エラーハンドリング
          magick.stdout.on("error", (err) => {
            logger.error(`[magick->res pipeline error] ${err.message}`);

            // ImageMagickパイプラインエラー時は元画像を送信
            logger.info(`[ImageMagickパイプラインエラー→元画像送信][${label}] ${displayPath}`);

            // HTTPヘッダー設定（まだ送信されていない場合）
            if (!res.headersSent) {
              // 元画像のContent-Typeを設定
              const fileExt = path.extname(fullPath).toLowerCase();
              let contentType = 'application/octet-stream';
              if (fileExt === '.jpg' || fileExt === '.jpeg') contentType = 'image/jpeg';
              else if (fileExt === '.png') contentType = 'image/png';
              else if (fileExt === '.gif') contentType = 'image/gif';
              else if (fileExt === '.webp') contentType = 'image/webp';
              else if (fileExt === '.bmp') contentType = 'image/bmp';
              else if (fileExt === '.tiff' || fileExt === '.tif') contentType = 'image/tiff';

              res.setHeader("Content-Type", contentType);
            }

            // 元画像ファイルを直接ストリーミング
            const fileStream = fs.createReadStream(fullPath);
            fileStream.pipe(res);

            fileStream.on("error", (streamErr) => {
              logger.error(`[元画像送信失敗][${label}] ${displayPath}: ${streamErr.message}`);
              if (!res.headersSent) res.writeHead(500);
              res.end("Failed to read original image");
              return reject(streamErr);
            });

            fileStream.on("end", () => {
              logger.info(`[変換完了(元画像)][${label}] ${displayPath}`);
              res.end();
              return resolve();
            });
          });

          // 書き込み完了時に原子的にリネーム
          writeStream.on("finish", () => {
            try {
              fs.renameSync(tmpPath, cachePath); // 原子的にリネーム
            } catch (e) {
              // リネーム失敗は無視（競合状態の可能性）
              logger.warn(`[キャッシュリネーム失敗] ${e.message}`);
            }
          });

        // 書き込みストリームエラー処理
        writeStream.on("error", (e) => {
          logger.warn(`[キャッシュ書き込みエラー] ${e.message}`);
          // キャッシュ失敗時はレスポンス継続（エラーを無視）
          // レスポンスは継続されるため、処理は正常に完了する
        });

        // レスポンス終了時の処理（Premature closeエラー対策）
        res.on("close", () => {
          if (!res.headersSent || res.writableEnded) {
            // レスポンスが正常に終了した場合は何もしない
            return;
          }
          // Premature closeの場合は強制的にresolveを呼ぶ
          logger.warn(`[Premature close検出] ${displayPath} - 強制完了`);

          // ImageMagickプロセスを強制終了
          if (magick && !magick.killed) {
            try {
              magick.kill('SIGTERM');
              logger.info(`[ImageMagick強制終了] ${displayPath}`);
            } catch (e) {
              // プロセス終了エラーは無視
            }
          }

          return resolve();
        });
        } catch (writeError) {
          logger.warn(`[キャッシュディレクトリ作成失敗] ${writeError.message}`);
          // キャッシュなしでレスポンス継続
          pipeline(magick.stdout, res).catch((err) => {
            // Premature closeエラーは頻発するため、ログレベルを調整
            if (err.message && err.message.includes('Premature close')) {
              logger.info(`[magick->res pipeline] ${err.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill('SIGTERM');
                  logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->res pipeline error] ${err.message}`);

              // ImageMagickパイプラインエラー時は元画像を送信
              logger.info(`[ImageMagickパイプラインエラー→元画像送信][${label}] ${displayPath}`);

              // HTTPヘッダー設定（まだ送信されていない場合）
              if (!res.headersSent) {
                // 元画像のContent-Typeを設定
                const fileExt = path.extname(fullPath).toLowerCase();
                let contentType = 'application/octet-stream';
                if (fileExt === '.jpg' || fileExt === '.jpeg') contentType = 'image/jpeg';
                else if (fileExt === '.png') contentType = 'image/png';
                else if (fileExt === '.gif') contentType = 'image/gif';
                else if (fileExt === '.webp') contentType = 'image/webp';
                else if (fileExt === '.bmp') contentType = 'image/bmp';
                else if (fileExt === '.tiff' || fileExt === '.tif') contentType = 'image/tiff';

                res.setHeader("Content-Type", contentType);
              }

              // 元画像ファイルを直接ストリーミング
              const fileStream = fs.createReadStream(fullPath);
              fileStream.pipe(res);

              fileStream.on("error", (streamErr) => {
                logger.error(`[元画像送信失敗][${label}] ${displayPath}: ${streamErr.message}`);
                if (!res.headersSent) res.writeHead(500);
                res.end("Failed to read original image");
                return reject(streamErr);
              });

              fileStream.on("end", () => {
                logger.info(`[変換完了(元画像)][${label}] ${displayPath}`);
                res.end();
                return resolve();
              });
            }
          });
        }
      } else {
          // キャッシュなしの場合は直接レスポンスにストリーミング
          pipeline(magick.stdout, res).catch((e) => {
            // Premature closeエラーは頻発するため、ログレベルを調整
            if (e.message && e.message.includes('Premature close')) {
              logger.info(`[magick->res pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill('SIGTERM');
                  logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->res pipeline error] ${e.message}`);

              // ImageMagickパイプラインエラー時は元画像を送信
              logger.info(`[ImageMagickパイプラインエラー→元画像送信][${label}] ${displayPath}`);

              // HTTPヘッダー設定（まだ送信されていない場合）
              if (!res.headersSent) {
                // 元画像のContent-Typeを設定
                const fileExt = path.extname(fullPath).toLowerCase();
                let contentType = 'application/octet-stream';
                if (fileExt === '.jpg' || fileExt === '.jpeg') contentType = 'image/jpeg';
                else if (fileExt === '.png') contentType = 'image/png';
                else if (fileExt === '.gif') contentType = 'image/gif';
                else if (fileExt === '.webp') contentType = 'image/webp';
                else if (fileExt === '.bmp') contentType = 'image/bmp';
                else if (fileExt === '.tiff' || fileExt === '.tif') contentType = 'image/tiff';

                res.setHeader("Content-Type", contentType);
              }

              // 元画像ファイルを直接ストリーミング
              const fileStream = fs.createReadStream(fullPath);
              fileStream.pipe(res);

              fileStream.on("error", (streamErr) => {
                logger.error(`[元画像送信失敗][${label}] ${displayPath}: ${streamErr.message}`);
                if (!res.headersSent) res.writeHead(500);
                res.end("Failed to read original image");
                return reject(streamErr);
              });

              fileStream.on("end", () => {
                logger.info(`[変換完了(元画像)][${label}] ${displayPath}`);
                res.end();
                return resolve();
              });
            }
          }); // レスポンスはパイプラインで自動終了
        }

        // 変換完了時の処理
        let magickResponseSize = 0; // ImageMagickレスポンスサイズ
        magick.stdout.on("data", (chunk) => {
          magickResponseSize += chunk.length; // レスポンスサイズを累計
        });
        magick.stdout.on("end", () => {
          logger.info(`[変換完了(ImageMagick)][${label}] ${displayPath} (サイズ: ${magickResponseSize.toLocaleString()} bytes)`); // ImageMagick変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });

        // Premature closeエラー対策（onErrorFallback内）
        res.on("close", () => {
          if (!res.headersSent || res.writableEnded) {
            // レスポンスが正常に終了した場合は何もしない
            return;
          }
          // Premature closeの場合は強制的にresolveを呼ぶ
          logger.warn(`[Premature close検出(fallback)] ${displayPath} - 強制完了`);

          // ImageMagickプロセスを強制終了
          if (magick && !magick.killed) {
            try {
              magick.kill('SIGTERM');
              logger.info(`[ImageMagick強制終了] ${displayPath}`);
            } catch (e) {
              // プロセス終了エラーは無視
            }
          }

          return resolve();
        });
      };

      // エラーハンドリングの設定
      transformer.on("error", (err) => {
        clearTimeout(sharpTimeout); // タイムアウトをクリア
        const errorMsg = err && err.message ? err.message : err;

        // Premature closeエラーの場合は直接スキップ（フォールバックしない）
        if (errorMsg.includes('Premature close')) {
          logger.info(`[Sharp Premature close - スキップ] ${displayPath}`);
          if (res && !res.headersSent) {
            res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Request cancelled due to stream error');
          }
          return resolve();
        }

        onErrorFallback(err); // その他のSharp変換エラー時にフォールバック
      });
      pass.on("error", (err) => {
        clearTimeout(sharpTimeout); // タイムアウトをクリア
        const errorMsg = err && err.message ? err.message : err;

        // Premature closeエラーの場合は直接スキップ（フォールバックしない）
        if (errorMsg.includes('Premature close')) {
          logger.info(`[PassThrough Premature close - スキップ] ${displayPath}`);
          if (res && !res.headersSent) {
            res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Request cancelled due to stream error');
          }
          return resolve();
        }

        onErrorFallback(err); // その他のPassThroughエラー時にフォールバック
      });

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
          responseSize += chunk.length; // レスポンスサイズを累計
        });

        // ストリーミング処理の設定（エラーハンドリング付き）
        pipeline(pass, writeStream).catch((e) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (e.message && e.message.includes('Premature close')) {
            logger.info(`[cache write pipeline] ${e.message}`);
          } else {
            logger.error(`[cache write pipeline error] ${e.message}`);
          }
          // キャッシュ書き込み失敗時はレスポンス継続
        }); // キャッシュ書き込み
        pipeline(pass, res).catch((e) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (e.message && e.message.includes('Premature close')) {
            logger.info(`[response pipeline] ${e.message}`);
          } else {
            logger.error(`[response pipeline error] ${e.message}`);
          }
          // レスポンスエラー時は適切に終了
        }); // レスポンス送信

        // ストリーム終了時の処理
        pass.on("end", async () => {
          // Sharp変換タイムアウトをクリア
          clearTimeout(sharpTimeout);

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

          logger.info(`[変換完了(Sharp)][${label}] ${displayPath} (サイズ: ${responseSize.toLocaleString()} bytes)`); // Sharp変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });
      } else {
        /**
         * キャッシュなしの場合の処理
         * 直接レスポンスにストリーミング
         */
        pass.on("data", (chunk) => {
          if (!wroteHeader) { // 最初のチャンク受信時にHTTPヘッダー送信（チャンク転送）
            res.writeHead(200, { // レスポンスヘッダーを設定
              "Content-Type": "image/webp", // WebP画像のMIMEタイプ
              Connection: "Keep-Alive", // Keep-Alive接続
              "Keep-Alive": "timeout=600", // Keep-Aliveタイムアウト
            });
            wroteHeader = true; // ヘッダー送信フラグを設定
          }
          responseSize += chunk.length; // レスポンスサイズを累計
        });

        pipeline(pass, res).catch((e) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (e.message && e.message.includes('Premature close')) {
            logger.info(`[response pipeline] ${e.message}`);
          } else {
            logger.error(`[response pipeline error] ${e.message}`);
          }
          // レスポンスエラー時は適切に終了
        }); // レスポンス送信

        // ストリーム終了時の処理

        pass.on("end", () => {
          // Sharp変換タイムアウトをクリア
          clearTimeout(sharpTimeout);

          logger.info(`[変換完了(Sharp)][${label}] ${fullPath} (サイズ: ${responseSize.toLocaleString()} bytes)`); // Sharp変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });

        // レスポンス終了時の処理（Premature closeエラー対策）
        res.on("close", () => {
          if (!res.headersSent || res.writableEnded) {
            // レスポンスが正常に終了した場合は何もしない
            return;
          }
          // Premature closeの場合は強制的にresolveを呼ぶ
          logger.warn(`[Premature close検出(キャッシュなし)] ${displayPath} - 強制完了`);
          return resolve();
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
        try {
          // 親ディレクトリの存在確認と作成
          const tmpDir = path.dirname(tmpPath);
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
          }

          const writeStream = fs.createWriteStream(tmpPath); // 一時ファイルに書き込み

          // ImageMagickの標準出力を一時ファイルとレスポンスの両方にストリーミング
          pipeline(magick.stdout, writeStream).catch((e) => {
            // Premature closeエラーは頻発するため、ログレベルを調整
            if (e.message && e.message.includes('Premature close')) {
              logger.info(`[magick->tmp pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill('SIGTERM');
                  logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->tmp pipeline error] ${e.message}`);
            }
            // キャッシュ書き込み失敗時はレスポンス継続
          }); // キャッシュ書き込み
          magick.stdout.pipe(res, { end: false }); // レスポンスは手動で終了

          // 書き込み完了時の原子的リネーム処理
          writeStream.on("finish", async () => {
            try {
              await fs.promises.rename(tmpPath, cachePath).catch((e) => {
                logger.warn(`[初期化エラー時キャッシュリネーム失敗] ${e.message}`);
              }); // リネーム失敗は警告ログ出力
            } catch (e) {
              logger.warn(`[初期化エラー時キャッシュリネーム例外] ${e.message}`);
            }
          });

          // 書き込みストリームエラー処理
          writeStream.on("error", (e) => {
            logger.warn(`[初期化エラー時キャッシュ書き込みエラー] ${e.message}`);
          });
        } catch (writeError) {
          logger.warn(`[初期化エラー時キャッシュディレクトリ作成失敗] ${writeError.message}`);
        }
      } else {
          // キャッシュなしの場合は直接レスポンスにストリーミング
          pipeline(magick.stdout, res).catch((e) => {
            // Premature closeエラーは頻発するため、ログレベルを調整
            if (e.message && e.message.includes('Premature close')) {
              logger.info(`[magick->res pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill('SIGTERM');
                  logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->res pipeline error] ${e.message}`);
            }
            // レスポンスエラー時は適切に終了
          }); // レスポンスはパイプラインで自動終了
      }

      // レスポンス終了時の処理（スタック処理では不要）

      // 変換完了時の処理
      let initErrorResponseSize = 0; // Sharp初期化エラー時のレスポンスサイズ
      magick.stdout.on("data", (chunk) => {
        initErrorResponseSize += chunk.length; // レスポンスサイズを累計
      });
      magick.stdout.on("end", () => {
        logger.info(`[変換完了(ImageMagick)][${label}] ${displayPath} (サイズ: ${initErrorResponseSize.toLocaleString()} bytes)`); // ImageMagick変換完了ログを出力
        res.end(); // レスポンス終了
        return resolve(); // 成功
      });

      // レスポンス終了時の処理（Premature closeエラー対策）
      res.on("close", () => {
        if (!res.headersSent || res.writableEnded) {
          // レスポンスが正常に終了した場合は何もしない
          return;
        }
        // Premature closeの場合は強制的にresolveを呼ぶ
        logger.warn(`[Premature close検出(初期化エラー)] ${displayPath} - 強制完了`);

        // ImageMagickプロセスを強制終了
        if (magick && !magick.killed) {
          try {
            magick.kill('SIGTERM');
            logger.info(`[ImageMagick強制終了] ${displayPath}`);
          } catch (e) {
            // プロセス終了エラーは無視
          }
        }

        return resolve();
      });
    }
  });

  // HTTPサーバーのメイン処理のエラーハンドリング（スタック処理では簡素化）
  httpServer.on('request', (req, res) => {
    res.on('error', (err) => {
      logger.error('Response error', err);
    });
  });
}
