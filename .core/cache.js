// === キャッシュ管理モジュール ===
const fs = require("fs");
const path = require("path");
const { logger, getCacheMinSize, getCacheTTL } = require("./config");

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

/**
 * キャッシュディレクトリの定期クリーニング関数（非同期版）
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

/**
 * キャッシュディレクトリ作成＆リセット（初回起動時）
 */
function initializeCacheDirectory() {
  // キャッシュディレクトリの設定（権限問題対応）
  let CACHE_DIR = "Y:/caches/webdav/tmp"; // キャッシュファイル保存ディレクトリ
  const FALLBACK_CACHE_DIR = path.join(__dirname, "..", "cache"); // 代替キャッシュディレクトリ

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
      return FALLBACK_CACHE_DIR;
    } catch (fallbackError) {
      logger.error(`[代替キャッシュディレクトリも失敗] ${FALLBACK_CACHE_DIR}: ${fallbackError.message}`);
      logger.warn("[キャッシュ機能を無効化] すべてのキャッシュディレクトリで書き込み権限なし");
      return null; // キャッシュ無効化
    }
  }
}

/**
 * キャッシュ管理システムの初期化
 * @returns {string|null} 有効なキャッシュディレクトリパス、またはnull
 */
function initializeCacheSystem() {
  const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30分 - キャッシュクリーニング実行間隔

  const activeCacheDir = initializeCacheDirectory();
  if (activeCacheDir) {
    logger.info("=== キャッシュリセット中... ===");
    resetCacheSync(activeCacheDir);
    logger.info("=== キャッシュリセット完了 ===");

    // 定期クリーニングの開始（30分間隔で実行）
    setInterval(() => cleanupCache(activeCacheDir), CLEANUP_INTERVAL_MS);
    logger.info(`[定期クリーニング設定] ${activeCacheDir} を ${CLEANUP_INTERVAL_MS/1000}秒間隔で監視中`);
  } else {
    logger.warn("=== キャッシュ機能が無効化されました ===");
  }

  return activeCacheDir;
}

module.exports = {
  resetCacheSync,
  cleanupCache,
  initializeCacheDirectory,
  initializeCacheSystem
};
