// === メモリキャッシュシステムモジュール ===
// 変換後画像データをメモリに保持し、高速レスポンスを実現

const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit");
const { logger, getDynamicConfig } = require("./config");

/**
 * メモリキャッシュ管理クラス
 * フォルダ単位で変換後画像データをメモリに保持
 */
class MemoryCache {
  constructor() {
    // フォルダ単位のキャッシュ（キー: フォルダパス、値: Map<キャッシュキー, 画像データ>）
    this.folderCache = new Map();
    // 現在のフォルダパス
    this.currentFolder = null;
    // 事前変換中フラグ（フォルダ単位）
    this.preloadingFolders = new Set();
    // 事前変換タスクのキャンセル用（フォルダ単位）
    this.preloadCancellers = new Map();
  }

  /**
   * 設定値の取得
   */
  getPreloadEnabled() {
    const value = getDynamicConfig("PRELOAD_ENABLED", "true");
    // getDynamicConfigはENABLEDキーの場合、booleanを返す可能性がある
    if (typeof value === "boolean") {
      return value;
    }
    return value === "true" || value === true;
  }

  getPreloadMaxFiles() {
    return parseInt(getDynamicConfig("PRELOAD_MAX_FILES", "50"), 10) || 50;
  }

  getMemoryCacheMaxSize() {
    // メモリキャッシュの最大サイズ（MB）
    return parseInt(getDynamicConfig("MEMORY_CACHE_MAX_SIZE_MB", "512"), 10) || 512;
  }

  getPreloadConcurrency() {
    // 事前変換の並列数（メイン処理に影響を与えないように制限）
    return parseInt(getDynamicConfig("PRELOAD_CONCURRENCY", "5"), 10) || 5;
  }

  /**
   * キャッシュキーから画像データを取得
   * @param {string} folderPath - フォルダパス
   * @param {string} cacheKey - キャッシュキー
   * @returns {Buffer|null} 画像データ（存在しない場合はnull）
   */
  get(folderPath, cacheKey) {
    const folderData = this.folderCache.get(folderPath);
    if (!folderData) return null;

    const cached = folderData.get(cacheKey);
    if (!cached) return null;

    // キャッシュヒットログ（デバッグ用、必要に応じてコメントアウト）
    //logger.info(`[メモリキャッシュヒット] ${folderPath}/${cacheKey.substring(0, 8)}...`);

    return cached.data;
  }

  /**
   * 画像データをキャッシュに保存
   * @param {string} folderPath - フォルダパス
   * @param {string} cacheKey - キャッシュキー
   * @param {Buffer} imageData - 画像データ
   */
  set(folderPath, cacheKey, imageData) {
    // メモリ使用量チェック
    const maxSizeBytes = this.getMemoryCacheMaxSize() * 1024 * 1024;
    const currentSize = this.getTotalMemoryUsage();

    // メモリ制限を超える場合は古いフォルダのキャッシュを削除
    if (currentSize + imageData.length > maxSizeBytes) {
      this.evictOldestFolder();
    }

    // フォルダ単位のキャッシュを取得または作成
    if (!this.folderCache.has(folderPath)) {
      this.folderCache.set(folderPath, new Map());
    }

    const folderData = this.folderCache.get(folderPath);
    folderData.set(cacheKey, {
      data: imageData,
      timestamp: Date.now(),
    });

    // メモリ使用量が制限を超えた場合は古いエントリを削除
    if (this.getTotalMemoryUsage() > maxSizeBytes) {
      this.evictOldestEntries(folderPath);
    }
  }

  /**
   * フォルダのキャッシュをクリア
   * @param {string} folderPath - フォルダパス
   */
  clearFolder(folderPath) {
    if (this.folderCache.has(folderPath)) {
      const folderData = this.folderCache.get(folderPath);
      const entryCount = folderData.size;
      let totalSize = 0;
      for (const entry of folderData.values()) {
        totalSize += entry.data.length;
      }
      this.folderCache.delete(folderPath);
      // logger.info(
      //   `[メモリキャッシュクリア] フォルダ: ${folderPath}, エントリ数: ${entryCount}, サイズ: ${(totalSize / (1024 * 1024)).toFixed(2)}MB`
      // );
    }

    // 事前変換タスクをキャンセル
    if (this.preloadCancellers.has(folderPath)) {
      const cancel = this.preloadCancellers.get(folderPath);
      cancel();
      this.preloadCancellers.delete(folderPath);
      // logger.info(`[事前変換キャンセル] フォルダ変更によるキャンセル: ${folderPath}`);
    }
    this.preloadingFolders.delete(folderPath);
  }

  /**
   * 現在のフォルダを設定し、変更時は古いフォルダのキャッシュをクリア
   * @param {string} newFolderPath - 新しいフォルダパス
   */
  setCurrentFolder(newFolderPath) {
    if (this.currentFolder !== null && this.currentFolder !== newFolderPath) {
      // フォルダが変更された場合は古いフォルダのキャッシュをクリア
      this.clearFolder(this.currentFolder);
    }
    this.currentFolder = newFolderPath;
  }

  /**
   * 最も古いフォルダのキャッシュを削除
   */
  evictOldestFolder() {
    if (this.folderCache.size === 0) return;

    let oldestFolder = null;
    let oldestTime = Infinity;

    for (const [folderPath, folderData] of this.folderCache.entries()) {
      // 現在のフォルダは削除しない
      if (folderPath === this.currentFolder) continue;

      // フォルダ内の最も古いエントリのタイムスタンプを取得
      let folderOldestTime = Infinity;
      for (const entry of folderData.values()) {
        if (entry.timestamp < folderOldestTime) {
          folderOldestTime = entry.timestamp;
        }
      }

      if (folderOldestTime < oldestTime) {
        oldestTime = folderOldestTime;
        oldestFolder = folderPath;
      }
    }

    if (oldestFolder) {
      // logger.info(`[メモリキャッシュ削除] 古いフォルダ: ${oldestFolder}`);
      this.clearFolder(oldestFolder);
    }
  }

  /**
   * フォルダ内の最も古いエントリを削除
   * @param {string} folderPath - フォルダパス
   */
  evictOldestEntries(folderPath) {
    const folderData = this.folderCache.get(folderPath);
    if (!folderData || folderData.size === 0) return;

    // タイムスタンプでソートして最も古いエントリを削除
    const entries = Array.from(folderData.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    // 最も古い25%を削除
    const removeCount = Math.max(1, Math.floor(entries.length * 0.25));
    for (let i = 0; i < removeCount; i++) {
      folderData.delete(entries[i][0]);
    }

    logger.info(
      `[メモリキャッシュ削除] フォルダ: ${folderPath}, ${removeCount}件のエントリを削除`
    );
  }

  /**
   * 総メモリ使用量を取得（バイト）
   * @returns {number} 総メモリ使用量
   */
  getTotalMemoryUsage() {
    let total = 0;
    for (const folderData of this.folderCache.values()) {
      for (const entry of folderData.values()) {
        total += entry.data.length;
      }
    }
    return total;
  }

  /**
   * キャッシュ統計を取得
   * @returns {Object} キャッシュ統計情報
   */
  getStats() {
    const totalSize = this.getTotalMemoryUsage();
    let totalEntries = 0;
    for (const folderData of this.folderCache.values()) {
      totalEntries += folderData.size;
    }

    return {
      folderCount: this.folderCache.size,
      totalEntries,
      totalSizeBytes: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      maxSizeMB: this.getMemoryCacheMaxSize(),
      currentFolder: this.currentFolder,
      preloadingFolders: Array.from(this.preloadingFolders),
    };
  }
}

// シングルトンインスタンス
const memoryCache = new MemoryCache();

/**
 * フォルダ内の画像ファイル数をカウント
 * @param {string} folderPath - フォルダパス
 * @returns {Promise<number>} 画像ファイル数
 */
async function countImageFilesInFolder(folderPath) {
  const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif"];
  let count = 0;

  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.includes(ext)) {
          count++;
        }
      }
    }
  } catch (err) {
    logger.warn(`[事前変換] フォルダ読み込みエラー: ${folderPath} - ${err.message}`);
  }

  return count;
}

/**
 * フォルダ内の画像ファイルを取得
 * @param {string} folderPath - フォルダパス
 * @param {number} maxFiles - 最大ファイル数
 * @returns {Promise<string[]>} 画像ファイルパスの配列
 */
async function getImageFilesInFolder(folderPath, maxFiles) {
  const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif"];
  const files = [];

  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTS.includes(ext)) {
          files.push(path.join(folderPath, entry.name));
        }
      }
    }
  } catch (err) {
    logger.warn(`[事前変換] フォルダ読み込みエラー: ${folderPath} - ${err.message}`);
  }

  return files;
}

/**
 * 事前変換処理（バックグラウンドで実行）
 * @param {string} folderPath - フォルダパス
 * @param {Function} convertFunction - 画像変換関数 (fullPath, cacheKey) => Promise<Buffer>
 * @param {Function} getCacheKeyFunction - キャッシュキー生成関数 (fullPath, st) => string
 */
async function preloadFolderImages(folderPath, convertFunction, getCacheKeyFunction) {
  // 事前変換が無効の場合は何もしない
  if (!memoryCache.getPreloadEnabled()) {
    // logger.info(`[事前変換スキップ] 事前変換が無効: ${folderPath}`);
    return;
  }

  // 既に事前変換中の場合はスキップ
  if (memoryCache.preloadingFolders.has(folderPath)) {
    // logger.info(`[事前変換スキップ] 既に事前変換中: ${folderPath}`);
    return;
  }

  // 最大ファイル数を取得
  const maxFiles = memoryCache.getPreloadMaxFiles();

  // フォルダ内の全画像ファイル数をカウント
  const totalImageCount = await countImageFilesInFolder(folderPath);

  // ファイル数が設定枚数以上の場合は事前変換をスキップ
  if (totalImageCount >= maxFiles) {
    // logger.info(
    //   `[事前変換スキップ] フォルダ: ${folderPath}, ファイル数: ${totalImageCount} (設定値: ${maxFiles}以上)`
    // );
    return;
  }

  // 画像ファイルを取得（実際のファイル数が設定値未満の場合のみ）
  const imageFiles = await getImageFilesInFolder(folderPath, maxFiles);

  // 事前変換中フラグを設定
  memoryCache.preloadingFolders.add(folderPath);

  // キャンセル用のフラグ
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  memoryCache.preloadCancellers.set(folderPath, cancel);

  // 事前変換専用の並列制限を設定（メイン処理に影響を与えないように）
  const preloadConcurrency = memoryCache.getPreloadConcurrency();
  const preloadLimit = pLimit(preloadConcurrency);

  // logger.info(
  //   `[事前変換開始] フォルダ: ${folderPath}, ファイル数: ${imageFiles.length}, 並列数: ${preloadConcurrency}`
  // );

  // バックグラウンドで並列変換（メイン処理に影響を与えない）
  let convertedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  // 並列処理用のタスク配列を作成
  const tasks = imageFiles.map((imageFile, index) => {
    return preloadLimit(async () => {
      // タスク開始時のキャンセルチェック（キューに入る前にチェック）
      if (cancelled) {
        return { type: "cancelled", index };
      }

      // フォルダが変更された場合は中断
      if (memoryCache.currentFolder !== folderPath) {
        return { type: "interrupted", index };
      }

      const fileName = path.basename(imageFile);

      try {
        // ファイルのstatを取得
        const st = await fs.promises.stat(imageFile).catch(() => null);
        if (!st || !st.isFile()) {
          return { type: "skipped", index, reason: "not_file" };
        }

        // キャッシュキーを生成
        const cacheKey = getCacheKeyFunction(imageFile, st);

        // 既にキャッシュされている場合はスキップ
        if (memoryCache.get(folderPath, cacheKey)) {
          // logger.info(`[事前変換スキップ(既存)] ${fileName} (${index + 1}/${imageFiles.length})`);
          return { type: "skipped", index, reason: "cached" };
        }

        // 変換処理を実行（非同期で実行、エラーは無視）
        try {
          const convertStartTime = Date.now();
          const imageData = await convertFunction(imageFile, cacheKey);
          const convertTime = Date.now() - convertStartTime;

          if (imageData && !cancelled && memoryCache.currentFolder === folderPath) {
            memoryCache.set(folderPath, cacheKey, imageData);
            // logger.info(
            //   `[事前変換成功] ${fileName} (${index + 1}/${imageFiles.length}) - サイズ: ${imageData.length.toLocaleString()} bytes, 時間: ${convertTime}ms`
            // );
            return { type: "converted", index };
          } else if (!imageData) {
            logger.warn(`[事前変換失敗] ${fileName} (${index + 1}/${imageFiles.length}) - 変換データがnull`);
            return { type: "error", index };
          }
          return { type: "skipped", index, reason: "cancelled_or_interrupted" };
        } catch (convertErr) {
          // 変換エラーは無視（ログのみ）
          logger.warn(`[事前変換エラー] ${fileName} (${index + 1}/${imageFiles.length}) - ${convertErr.message}`);
          return { type: "error", index };
        }
      } catch (err) {
        logger.warn(`[事前変換例外] ${fileName} (${index + 1}/${imageFiles.length}) - ${err.message}`);
        return { type: "error", index };
      }
    });
  });

  // すべてのタスクを並列実行（キャンセル時は中断）
  const results = await Promise.allSettled(tasks);

  // 結果を集計
  for (const result of results) {
    if (result.status === "fulfilled") {
      const data = result.value;
      if (data) {
        if (data.type === "converted") {
          convertedCount++;
        } else if (data.type === "skipped") {
          skippedCount++;
        } else if (data.type === "error") {
          errorCount++;
        } else if (data.type === "cancelled") {
          logger.info(`[事前変換キャンセル] フォルダ: ${folderPath}, 進捗: ${data.index}/${imageFiles.length}`);
          break;
        } else if (data.type === "interrupted") {
          logger.info(`[事前変換中断] フォルダ変更検出: ${folderPath}, 進捗: ${data.index}/${imageFiles.length}`);
          break;
        }
      }
    } else {
      errorCount++;
    }
  }

  // 事前変換中フラグを解除
  memoryCache.preloadingFolders.delete(folderPath);
  memoryCache.preloadCancellers.delete(folderPath);

  const totalTime = Date.now() - startTime;
  const stats = memoryCache.getStats();

  // logger.info(
  //   `[事前変換完了] フォルダ: ${folderPath}, 変換: ${convertedCount}, スキップ: ${skippedCount}, エラー: ${errorCount}, 総数: ${imageFiles.length}, 時間: ${totalTime}ms`
  // );
  // logger.info(
  //   `[メモリキャッシュ統計] フォルダ数: ${stats.folderCount}, 総エントリ: ${stats.totalEntries}, 使用量: ${stats.totalSizeMB}MB/${stats.maxSizeMB}MB`
  // );
}

module.exports = {
  memoryCache,
  preloadFolderImages,
};
