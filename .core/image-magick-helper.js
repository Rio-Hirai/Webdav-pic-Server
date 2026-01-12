// === ImageMagick処理共通ヘルパーモジュール ===
// ImageMagick処理の重複コードを削減するための共通関数群

const fs = require("fs");
const path = require("path");
const stream = require("stream");
const { promisify } = require("util");
const { spawn } = require("child_process");
const {
  logger,
  MAGICK_CMD,
  getImageMode,
  getWebpEffort,
  getWebpEffortFast,
  getWebpPreset,
  getWebpReductionEffort,
} = require("./config");

const pipeline = promisify(stream.pipeline);

/**
 * Content-Typeをファイル拡張子から取得
 * @param {string} filePath - ファイルパス
 * @returns {string} Content-Type
 */
function getContentTypeFromPath(filePath) {
  const fileExt = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".heic": "image/heic",
    ".heif": "image/heic",
  };
  return contentTypes[fileExt] || "application/octet-stream";
}

/**
 * 元画像を直接送信する共通処理
 * @param {Object} params - パラメータ
 * @param {string} params.fullPath - 元画像のフルパス
 * @param {string} params.displayPath - 表示用パス
 * @param {Object} params.res - HTTPレスポンスオブジェクト
 * @param {number} params.originalSize - 元画像サイズ
 * @param {Function} params.statsRecorder - 統計記録関数
 * @param {Function} params.resolve - Promise resolve関数
 * @param {Function} params.reject - Promise reject関数
 */
function sendOriginalImage({
  fullPath,
  displayPath,
  res,
  originalSize,
  statsRecorder,
  resolve,
  reject,
}) {
  const contentType = getContentTypeFromPath(fullPath);

  if (!res.headersSent) {
    res.setHeader("Content-Type", contentType);
  }

  const fileStream = fs.createReadStream(fullPath);
  fileStream.pipe(res);

  fileStream.on("error", (streamErr) => {
    logger.error(`[元画像送信失敗] ${displayPath}: ${streamErr.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end("Failed to read original image");
    return reject(streamErr);
  });

  fileStream.on("end", () => {
    logger.info(`[変換完了(元画像)] ${displayPath}`);
    if (statsRecorder) statsRecorder.record(originalSize);
    res.end();
    return resolve();
  });
}

/**
 * ImageMagickリサイズオプションを生成
 * @param {number|null} Photo_Size - リサイズサイズ
 * @param {boolean} isFast - 高速処理モードかどうか
 * @param {string} fullPath - ファイルパス（メタデータ取得用、オプション）
 * @returns {Promise<string[]>} リサイズオプション配列
 */
async function buildResizeOptions(Photo_Size, isFast, fullPath = null) {
  if (!Photo_Size) return [];

  if (isFast) {
    // 高速処理モード: 幅を基準に単純リサイズ
    return ["-resize", `${Photo_Size}x`];
  } else {
    // バランス/高圧縮モード: 縦横を比較して短辺に合わせる
    if (!fullPath) {
      // メタデータ取得ができない場合は幅基準
      return ["-resize", `${Photo_Size}x`];
    }

    try {
      const identifyCmd = spawn(MAGICK_CMD, [
        "identify",
        "-format",
        "%wx%h",
        fullPath,
      ]);
      let identifyOutput = "";

      identifyCmd.stdout.on("data", (chunk) => {
        identifyOutput += chunk.toString();
      });

      return new Promise((resolve) => {
        identifyCmd.on("close", (code) => {
          if (code === 0) {
            const [width, height] = identifyOutput
              .trim()
              .split("x")
              .map(Number);
            if (width < height) {
              resolve(["-resize", `${Photo_Size}x`]);
            } else {
              resolve(["-resize", `x${Photo_Size}`]);
            }
          } else {
            // メタデータ取得失敗時は幅基準
            resolve(["-resize", `${Photo_Size}x`]);
          }
        });
        identifyCmd.on("error", () => {
          // エラー時は幅基準
          resolve(["-resize", `${Photo_Size}x`]);
        });
      });
    } catch (e) {
      // 例外時は幅基準
      return ["-resize", `${Photo_Size}x`];
    }
  }
}

/**
 * ImageMagick WebPオプションを生成
 * @param {number} quality - WebP品質
 * @param {boolean} isFast - 高速処理モードかどうか
 * @returns {string[]} WebPオプション配列
 */
function buildWebpOptions(quality, isFast) {
  const effortVal = isFast ? getWebpEffortFast() : getWebpEffort();
  const presetVal = getWebpPreset();
  const reductionEffortVal = getWebpReductionEffort();

  const options = [
    "-quality",
    `${quality}`,
    "-define",
    `webp:effort=${effortVal}`,
    "-define",
    `webp:preset=${presetVal}`,
    "-define",
    `webp:reduction-effort=${reductionEffortVal}`,
    "-define",
    "webp:near-lossless=false",
  ];

  if (!isFast) {
    // バランス/高圧縮モードではスマートサブサンプリングを有効
    options.push("-define", "webp:smart-subsample=true");
  }

  return options;
}

/**
 * ImageMagickプロセスを起動
 * @param {Object} params - パラメータ
 * @param {string} params.fullPath - 入力画像パス
 * @param {number|null} params.Photo_Size - リサイズサイズ
 * @param {number} params.quality - WebP品質
 * @param {boolean} params.isFast - 高速処理モードかどうか
 * @param {boolean} params.useAdvancedOptions - 高度なWebPオプションを使用するか
 * @returns {Object} { magick, resizeOpt } - ImageMagickプロセスとリサイズオプション
 */
async function spawnImageMagick({
  fullPath,
  Photo_Size,
  quality,
  isFast,
  useAdvancedOptions = false,
}) {
  const resizeOpt = await buildResizeOptions(Photo_Size, isFast, fullPath);

  let magickArgs = [fullPath, ...resizeOpt];

  if (useAdvancedOptions) {
    // HEIC処理など、高度なWebPオプションを使用
    const webpOptions = buildWebpOptions(quality, isFast);
    magickArgs = [...magickArgs, ...webpOptions, "webp:-"];
  } else {
    // シンプルなフォールバック処理
    magickArgs = [...magickArgs, "-quality", `${quality}`, "webp:-"];
  }

  const magick = spawn(MAGICK_CMD, magickArgs);

  return { magick, resizeOpt };
}

/**
 * ImageMagickプロセスのエラーハンドリングを設定
 * @param {Object} params - パラメータ
 * @param {Object} params.magick - ImageMagickプロセス
 * @param {string} params.fullPath - 入力画像パス
 * @param {string} params.displayPath - 表示用パス
 * @param {Object} params.res - HTTPレスポンスオブジェクト
 * @param {number} params.originalSize - 元画像サイズ
 * @param {Function} params.statsRecorder - 統計記録関数
 * @param {Function} params.resolve - Promise resolve関数
 * @param {Function} params.reject - Promise reject関数
 */
function setupImageMagickErrorHandling({
  magick,
  fullPath,
  displayPath,
  res,
  originalSize,
  statsRecorder,
  resolve,
  reject,
}) {
  magick.on("error", (err) => {
    logger.error(`[ImageMagick変換失敗] ${fullPath}: ${err}`);
    logger.info(`[ImageMagick失敗→元画像送信] ${displayPath}`);
    sendOriginalImage({
      fullPath,
      displayPath,
      res,
      originalSize,
      statsRecorder,
      resolve,
      reject,
    });
  });
}

/**
 * Premature closeエラーの処理
 * @param {Error} e - エラーオブジェクト
 * @param {Object} magick - ImageMagickプロセス
 * @param {string} displayPath - 表示用パス
 * @param {string} context - コンテキスト（ログ用）
 * @returns {boolean} Premature closeエラーかどうか
 */
function handlePrematureClose(e, magick, displayPath, context = "") {
  if (e.message && e.message.includes("Premature close")) {
    logger.info(`[${context} Premature close] ${displayPath}: ${e.message}`);
    if (magick && !magick.killed) {
      try {
        magick.kill("SIGTERM");
        logger.info(`[ImageMagick強制終了(Premature close)] ${displayPath}`);
      } catch (killErr) {
        logger.warn(`[プロセス終了エラー] ${displayPath}: ${killErr.message}`);
      }
    }
    return true;
  }
  return false;
}

module.exports = {
  getContentTypeFromPath,
  sendOriginalImage,
  buildResizeOptions,
  buildWebpOptions,
  spawnImageMagick,
  setupImageMagickErrorHandling,
  handlePrematureClose,
  pipeline,
};
