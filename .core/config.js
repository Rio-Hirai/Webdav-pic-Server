// === 設定管理モジュール ===
const fs = require("fs");
const path = require("path");

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
  error: (...args) =>
    console.error(`[${timestamp()}] ERROR: ${args.join(" ")}`), // errorはstderrに出力
  child: () => logger, // 子ロガー（互換性のため）
  flush: () => {}, // フラッシュ（互換性のため）
};

// ImageMagickコマンドパス設定
// 環境変数MAGICK_PATHが設定されていればそれを使用、未設定の場合は"magick"をデフォルトとする
const MAGICK_CMD = process.env.MAGICK_PATH || "magick";

// 設定ファイル監視と動的設定更新機能
const CONFIG_FILE = path.join(__dirname, "..", "config.txt");
const CONFIG_WATCH_INTERVAL = 10000; // 10秒間隔で設定ファイルを監視（より迅速な変更検出）

// 前回の設定値を保存するオブジェクト
let lastConfigValues = {};

/**
 * 設定値の検証関数
 * 各パラメータの入力規則をチェックし、不正な値の場合は既存値またはデフォルト値で代用
 */
function validateConfigValue(key, value, defaultValue) {
  // 数値型の設定検証
  if (
    key.includes("SIZE") ||
    key.includes("LIST") ||
    key.includes("MS") ||
    key.includes("QUALITY") ||
    key.includes("CONCURRENCY") ||
    key.includes("MEMORY") ||
    key.includes("PIXEL") ||
    key.includes("REQUESTS") ||
    key.includes("WINDOW") ||
    key.includes("QUEUE") ||
    key.includes("TIMEOUT") ||
    key.includes("ACTIVE")
  ) {
    const numValue = parseInt(value);

    // 基本的な数値チェック
    if (isNaN(numValue) || numValue < 0) {
      logger.warn(
        `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (数値が無効)`
      );
      return defaultValue;
    }

    // 具体的な範囲チェック
    switch (key) {
      case "DEFAULT_QUALITY":
        if (numValue < 10 || numValue > 100) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (品質は10-100の範囲)`
          );
          return defaultValue;
        }
        break;
      case "PHOTO_SIZE":
        if (numValue < 100 || numValue > 8192) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (サイズは100-8192の範囲)`
          );
          return defaultValue;
        }
        break;
      case "MAX_CONCURRENCY":
        if (numValue < 1 || numValue > 32) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (並列数は1-32の範囲)`
          );
          return defaultValue;
        }
        break;
      case "SHARP_MEMORY_LIMIT":
        if (numValue < 16 || numValue > 4096) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (メモリ制限は16-4096MBの範囲)`
          );
          return defaultValue;
        }
        break;
      case "SHARP_PIXEL_LIMIT":
        if (numValue < 1000000 || numValue > 1000000000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (ピクセル制限は1M-1000Mの範囲)`
          );
          return defaultValue;
        }
        break;
      case "WEBP_EFFORT":
      case "WEBP_EFFORT_FAST":
        // Sharp の webp effort は 0-6 の範囲。
        if (numValue < 0 || numValue > 6) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (Sharp の effort は 0-6 の範囲)`
          );
          return defaultValue;
        }
        return numValue; // 明示的に数値を返す
        break;
      case "CACHE_TTL_MS":
        if (numValue < 60000 || numValue > 86400000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (キャッシュTTLは1分-24時間の範囲)`
          );
          return defaultValue;
        }
        break;
      case "CACHE_MIN_SIZE":
        if (numValue < 1024 || numValue > 104857600) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (最小サイズは1KB-100MBの範囲)`
          );
          return defaultValue;
        }
        break;
      case "RATE_LIMIT_REQUESTS":
        if (numValue < 1 || numValue > 1000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (リクエスト制限は1-1000の範囲)`
          );
          return defaultValue;
        }
        break;
      case "RATE_LIMIT_WINDOW_MS":
        if (numValue < 1000 || numValue > 300000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (時間窓は1秒-5分の範囲)`
          );
          return defaultValue;
        }
        break;
      case "RATE_LIMIT_QUEUE_SIZE":
        if (numValue < 10 || numValue > 1000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (キューサイズは10-1000の範囲)`
          );
          return defaultValue;
        }
        break;
      case "STACK_MAX_SIZE":
        if (numValue < 50 || numValue > 500) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (スタックサイズは50-500の範囲)`
          );
          return defaultValue;
        }
        break;
      case "STACK_PROCESSING_DELAY_MS":
        if (numValue < 1 || numValue > 100) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (処理遅延は1-100msの範囲)`
          );
          return defaultValue;
        }
        break;
      case "MAX_LIST":
        if (numValue < 10 || numValue > 10000) {
          logger.warn(
            `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (リスト制限は10-10000の範囲)`
          );
          return defaultValue;
        }
        break;
    }

    return numValue;
  }

  // 真偽値型の設定検証
  if (key.includes("ENABLED")) {
    const lowerValue = value.toLowerCase();
    if (lowerValue !== "true" && lowerValue !== "false") {
      logger.warn(
        `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (真偽値はtrue/false)`
      );
      return defaultValue;
    }
    return lowerValue === "true";
  }

  // 浮動小数点型の設定検証
  if (key.includes("THRESHOLD")) {
    const floatValue = parseFloat(value);
    if (isNaN(floatValue) || floatValue < 0 || floatValue > 1) {
      logger.warn(
        `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (閾値は0.0-1.0の範囲)`
      );
      return defaultValue;
    }
    return floatValue;
  }

  // 時刻形式の設定検証
  if (key === "RESTART_TIME") {
    const timePattern = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timePattern.test(value)) {
      logger.warn(
        `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (時刻形式はHH:MM)`
      );
      return defaultValue;
    }
    return value;
  }

  // パス形式の設定検証
  if (key === "MAGICK_PATH") {
    if (typeof value !== "string" || value.trim() === "") {
      logger.warn(
        `[設定値無効] ${key}: "${value}" → デフォルト値 ${defaultValue} を使用 (パスが無効)`
      );
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
  if (key === "SHARP_PIXEL_LIMIT" && !global.sharpPixelLimitLogged) {
    logger.info(
      `[設定デバッグ] ${key}: "${value}" (型: ${typeof value}) → ${validatedValue} (型: ${typeof validatedValue})`
    );
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
      const configContent = fs.readFileSync(CONFIG_FILE, "utf8");
      const lines = configContent.split("\n");
      let updatedCount = 0;
      const currentConfigValues = {};

      // 現在の設定値を読み込み
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, value] = trimmed.split("=");
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
            logger.info(
              `[設定変更] ${key}: ${lastConfigValues[key]} → ${value}`
            );

            // 重要な設定変更の場合は追加情報を出力
            if (key === "DEFAULT_QUALITY") {
              logger.info(
                `[品質設定更新] 画像変換のデフォルト品質が ${value}% に変更されました`
              );
            } else if (key === "COMPRESSION_THRESHOLD") {
              logger.info(
                `[圧縮設定更新] 圧縮閾値が ${(parseFloat(value) * 100).toFixed(
                  1
                )}% に変更されました`
              );
            } else if (key === "COMPRESSION_ENABLED") {
              logger.info(
                `[圧縮設定更新] 圧縮機能が ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
            } else if (key === "PHOTO_SIZE") {
              logger.info(
                `[画像サイズ設定更新] 画像リサイズサイズが ${value}px に変更されました`
              );
            } else if (key === "MAX_LIST") {
              logger.info(
                `[リスト設定更新] 最大リスト数が ${value}件 に変更されました`
              );
            } else if (key === "CACHE_TTL_MS") {
              logger.info(
                `[キャッシュ設定更新] キャッシュ有効期間が ${Math.floor(
                  parseInt(value) / 1000
                )}秒 に変更されました`
              );
            } else if (key === "CACHE_MIN_SIZE") {
              logger.info(
                `[キャッシュ設定更新] キャッシュ最小サイズが ${Math.floor(
                  parseInt(value) / 1024
                )}KB に変更されました`
              );
            } else if (key === "MAX_CONCURRENCY") {
              logger.info(
                `[並列処理設定更新] 最大並列数が ${value} に変更されました`
              );
            } else if (key === "SHARP_MEMORY_LIMIT") {
              logger.info(
                `[Sharp設定更新] メモリキャッシュ制限が ${value}MB に変更されました`
              );
            } else if (key === "SHARP_PIXEL_LIMIT") {
              logger.info(
                `[Sharp設定更新] ピクセル制限が ${parseInt(
                  value
                ).toLocaleString()} に変更されました`
              );
            } else if (key === "RATE_LIMIT_ENABLED") {
              logger.info(
                `[レート制限設定更新] レート制限が ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
            } else if (key === "RATE_LIMIT_REQUESTS") {
              logger.info(
                `[レート制限設定更新] 1分間あたりのリクエスト数が ${value} に変更されました`
              );
            } else if (key === "RATE_LIMIT_WINDOW_MS") {
              logger.info(
                `[レート制限設定更新] 時間窓が ${value}ms に変更されました`
              );
            } else if (key === "RATE_LIMIT_QUEUE_SIZE") {
              logger.info(
                `[レート制限設定更新] キューサイズ制限が ${value} に変更されました`
              );
            } else if (key === "EMERGENCY_DISABLE_RATE_LIMIT") {
              logger.warn(
                `[緊急時設定更新] レート制限が ${
                  value === "true" ? "無効化" : "有効"
                } に変更されました`
              );
            } else if (key === "MAX_ACTIVE_REQUESTS") {
              logger.info(
                `[過負荷対策設定更新] 最大同時リクエスト数が ${value} に変更されました`
              );
            } else if (key === "REQUEST_TIMEOUT_MS") {
              logger.info(
                `[過負荷対策設定更新] リクエストタイムアウトが ${value}ms に変更されました`
              );
            } else if (key === "DROP_REQUESTS_WHEN_OVERLOADED") {
              logger.warn(
                `[過負荷対策設定更新] 過負荷時のリクエスト破棄が ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
            } else if (key === "AGGRESSIVE_DROP_ENABLED") {
              logger.warn(
                `[積極的破棄設定更新] 積極的破棄が ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
            } else if (key === "AGGRESSIVE_DROP_THRESHOLD") {
              logger.info(
                `[積極的破棄設定更新] 破棄閾値が ${value} リクエストに変更されました`
              );
            } else if (key === "AGGRESSIVE_DROP_WINDOW_MS") {
              logger.info(
                `[積極的破棄設定更新] 時間窓が ${value}ms に変更されました`
              );
            } else if (key === "EMERGENCY_RESET_ENABLED") {
              logger.warn(
                `[緊急リセット設定更新] 緊急リセットが ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
            } else if (key === "EMERGENCY_RESET_THRESHOLD") {
              logger.info(
                `[緊急リセット設定更新] リセット閾値が ${value} リクエストに変更されました`
              );
            } else if (key === "EMERGENCY_RESET_WINDOW_MS") {
              logger.info(
                `[緊急リセット設定更新] リセット時間窓が ${value}ms に変更されました`
              );
            } else if (key === "IMAGE_CONVERSION_ENABLED") {
              logger.info(
                `[画像変換設定更新] 画像変換機能が ${
                  value === "true" ? "有効" : "無効"
                } に変更されました`
              );
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
        const sharpRelatedKeys = [
          "MAX_CONCURRENCY",
          "SHARP_MEMORY_LIMIT",
          "SHARP_PIXEL_LIMIT",
        ];
        const hasSharpChanges = Object.keys(currentConfigValues).some(
          (key) =>
            sharpRelatedKeys.includes(key) &&
            lastConfigValues[key] !== currentConfigValues[key]
        );
        if (hasSharpChanges) {
          // Sharp設定の再適用は呼び出し元で行う
          return { sharpConfigChanged: true };
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

  return { sharpConfigChanged: false };
}

// 初期設定読み込み
loadConfig();

// 設定ファイル監視開始
// 注: Sharp設定の再適用はmain.jsの監視ループで実行
// 設定ファイル監視開始
// 注: Sharp設定の再適用はmain.jsの監視ループで実行
let configWatchIntervalId = setInterval(() => {
  loadConfig(); // 戻り値は使用しない（main.jsで処理）
}, CONFIG_WATCH_INTERVAL);
logger.info(
  `[設定監視開始] ${CONFIG_FILE} を ${
    CONFIG_WATCH_INTERVAL / 1000
  }秒間隔で監視中`
);

// 設定監視停止（シャットダウン時に設定ファイル監視を停止する）
function stopConfigMonitoring() {
  if (configWatchIntervalId) {
    // 設定監視が開始されている場合
    clearInterval(configWatchIntervalId); // 監視を停止
    configWatchIntervalId = null; // 監視IDをクリア
  }
}

// 圧縮機能の有効/無効制御（動的設定対応）
function getCompressionEnabled() {
  return process.env.COMPRESSION_ENABLED !== "false"; // 環境変数が"false"でない場合有効
}

function getCompressionThreshold() {
  return parseFloat(process.env.COMPRESSION_THRESHOLD) || 0.3; // 環境変数が存在しない場合は0.3
}

// 画像変換機能の有効/無効制御（動的設定対応）
function getImageConversionEnabled() {
  return getDynamicConfig("IMAGE_CONVERSION_ENABLED", true); // 環境変数が存在しない場合はtrue
}

// 動的キャッシュ設定読み込み関数
const getCacheMinSize = () =>
  getDynamicConfig("CACHE_MIN_SIZE", 1 * 1024 * 1024); // 1MB - キャッシュ対象の最小ファイルサイズ
const getCacheTTL = () => getDynamicConfig("CACHE_TTL_MS", 5 * 60 * 1000); // 5分 - キャッシュファイルの有効期間

// メモリ管理設定読み込み関数
const getMaxConcurrency = () => getDynamicConfig("MAX_CONCURRENCY", 16); // 最大並列処理数
const getSharpMemoryLimit = () => getDynamicConfig("SHARP_MEMORY_LIMIT", 256); // Sharpメモリキャッシュ制限（MB）
const getSharpPixelLimit = () =>
  getDynamicConfig("SHARP_PIXEL_LIMIT", 50000000); // Sharpピクセル制限

// レート制限設定読み込み関数
const getRateLimitEnabled = () => getDynamicConfig("RATE_LIMIT_ENABLED", true); // レート制限有効
const getRateLimitRequests = () => getDynamicConfig("RATE_LIMIT_REQUESTS", 50); // 1分間あたりのリクエスト数
const getRateLimitWindow = () =>
  getDynamicConfig("RATE_LIMIT_WINDOW_MS", 60000); // 時間窓（ミリ秒）
const getRateLimitQueueSize = () =>
  getDynamicConfig("RATE_LIMIT_QUEUE_SIZE", 100); // キューサイズ制限

// 過負荷対策設定読み込み関数
const getMaxActiveRequests = () => getDynamicConfig("MAX_ACTIVE_REQUESTS", 10); // 最大同時リクエスト数
const getRequestTimeout = () => getDynamicConfig("REQUEST_TIMEOUT_MS", 5000); // リクエストタイムアウト（ミリ秒）
const getDropRequestsWhenOverloaded = () =>
  getDynamicConfig("DROP_REQUESTS_WHEN_OVERLOADED", true); // 過負荷時のリクエスト破棄

// 積極的破棄設定読み込み関数
const getAggressiveDropEnabled = () =>
  getDynamicConfig("AGGRESSIVE_DROP_ENABLED", true); // 積極的破棄有効
const getAggressiveDropThreshold = () =>
  getDynamicConfig("AGGRESSIVE_DROP_THRESHOLD", 20); // 破棄閾値（リクエスト数）
const getAggressiveDropWindow = () =>
  getDynamicConfig("AGGRESSIVE_DROP_WINDOW_MS", 3000); // 時間窓（ミリ秒）

// 緊急リセット設定読み込み関数
const getEmergencyResetEnabled = () =>
  getDynamicConfig("EMERGENCY_RESET_ENABLED", true); // 緊急リセット有効
const getEmergencyResetThreshold = () =>
  getDynamicConfig("EMERGENCY_RESET_THRESHOLD", 15); // リセット閾値（リクエスト数）
const getEmergencyResetWindow = () =>
  getDynamicConfig("EMERGENCY_RESET_WINDOW_MS", 3000); // 時間窓（ミリ秒）

// サーバー設定読み込み関数
const getServerPort = () => getDynamicConfig("PORT", 1901); // サーバーポート
const getServerRootPath = () => getDynamicConfig("ROOT_PATH", "Z:/書籍"); // サーバールートパス
const getSSLCertPath = () => getDynamicConfig("SSL_CERT_PATH", ""); // SSL証明書パス
const getSSLKeyPath = () => getDynamicConfig("SSL_KEY_PATH", ""); // SSL秘密鍵パス

// 画像処理モード設定読み込み関数
const getImageMode = () => getDynamicConfig("IMAGE_MODE", 2); // 画像処理モード（1=高速処理、2=バランス処理、3=高圧縮処理）

// WebP effort 設定 (0-9)
const getWebpEffort = () => parseInt(getDynamicConfig("WEBP_EFFORT", 1)); // デフォルト 1 (バランス)
const getWebpEffortFast = () =>
  parseInt(getDynamicConfig("WEBP_EFFORT_FAST", 0)); // 高速モードのデフォルト 0

// WebP preset 設定
const getWebpPreset = () => getDynamicConfig("WEBP_PRESET", "default"); // デフォルト 'default'

// WebP reduction effort 設定
const getWebpReductionEffort = () =>
  parseInt(getDynamicConfig("WEBP_REDUCTION_EFFORT", 0)); // デフォルト 0

module.exports = {
  logger, // ロガー
  MAGICK_CMD, // ImageMagickコマンド
  getDynamicConfig, // 動的設定読み込み関数
  loadConfig, // 設定ファイル読み込み関数
  stopConfigMonitoring, // 設定監視停止関数
  getCompressionEnabled, // 圧縮機能の有効/無効制御
  getCompressionThreshold, // 圧縮閾値
  getImageConversionEnabled, // 画像変換機能の有効/無効制御
  getCacheMinSize, // キャッシュ対象の最小ファイルサイズ
  getCacheTTL, // キャッシュファイルの有効期間
  getMaxConcurrency, // 最大並列処理数
  getSharpMemoryLimit, // Sharpメモリキャッシュ制限（MB）
  getSharpPixelLimit, // Sharpピクセル制限
  getRateLimitEnabled, // レート制限有効
  getRateLimitRequests, // 1分間あたりのリクエスト数
  getRateLimitWindow, // 時間窓（ミリ秒）
  getRateLimitQueueSize, // キューサイズ制限
  getMaxActiveRequests, // 最大同時リクエスト数
  getRequestTimeout, // リクエストタイムアウト（ミリ秒）
  getDropRequestsWhenOverloaded, // 過負荷時のリクエスト破棄
  getAggressiveDropEnabled, // 積極的破棄有効
  getAggressiveDropThreshold, // 破棄閾値（リクエスト数）
  getAggressiveDropWindow, // 時間窓（ミリ秒）
  getEmergencyResetEnabled, // 緊急リセット有効
  getEmergencyResetThreshold, // リセット閾値（リクエスト数）
  getEmergencyResetWindow, // 時間窓（ミリ秒）
  getServerPort, // サーバーポート
  getServerRootPath, // サーバールートパス
  getSSLCertPath, // SSL証明書パス
  getSSLKeyPath, // SSL秘密鍵パス
  getImageMode, // 画像処理モード
  getWebpEffort, // WebP effort 設定 (0-9)
  getWebpEffortFast, // WebP effort fast 設定 (0-9)
  getWebpPreset, // WebP preset 設定
  getWebpReductionEffort, // WebP reduction effort 設定
};
