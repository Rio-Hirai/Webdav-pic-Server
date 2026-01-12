// === 事前変換Worker Thread ===
// メインスレッドの送信処理を阻害しないように、別スレッドで事前変換処理を実行

const { parentPort } = require("worker_threads");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");
const sharp = require("sharp");
const {
  getImageMode,
  getWebpEffort,
  getWebpEffortFast,
  getWebpPreset,
  getWebpReductionEffort,
  getSharpPixelLimit,
  getCompressionEnabled,
  getCompressionThreshold,
  MAGICK_CMD,
} = require("./config");

/**
 * 画像変換処理（Worker Thread内で実行）
 * SharpまたはImageMagickを使用して画像をWebP形式に変換
 */
async function convertImage({
  fullPath,
  cachePath,
  quality,
  Photo_Size,
  memoryOnly,
}) {
  const imageMode = getImageMode();
  const isFast = imageMode === 1;
  const fileExt = path.extname(fullPath).toLowerCase();
  const isHeicImage = fileExt === ".heic" || fileExt === ".heif";

  // HEIC画像の場合はImageMagickを使用
  if (isHeicImage) {
    return convertHeicWithImageMagick({
      fullPath,
      cachePath,
      quality,
      Photo_Size,
      memoryOnly,
    });
  }

  // Sharpを使用した変換
  return convertWithSharp({
    fullPath,
    cachePath,
    quality,
    Photo_Size,
    memoryOnly,
    isFast,
  });
}

/**
 * Sharpを使用した画像変換
 */
async function convertWithSharp({
  fullPath,
  cachePath,
  quality,
  Photo_Size,
  memoryOnly,
  isFast,
}) {
  return new Promise(async (resolve, reject) => {
    try {
      const effortVal = isFast ? getWebpEffortFast() : getWebpEffort();
      const presetVal = getWebpPreset();
      const reductionEffortVal = getWebpReductionEffort();
      const pixelLimit = getSharpPixelLimit();

      let transformer = sharp(fullPath, {
        limitInputPixels: pixelLimit,
      });

      // リサイズ処理
      if (Photo_Size) {
        transformer = transformer.resize(Photo_Size, null, {
          withoutEnlargement: true,
          fit: "inside",
        });
      }

      // WebP変換設定
      transformer = transformer.webp({
        quality: quality,
        effort: effortVal,
        preset: presetVal,
        reductionEffort: reductionEffortVal,
      });

      if (memoryOnly) {
        // メモリのみに保存（Bufferとして返す）
        const buffer = await transformer.toBuffer();
        resolve({ buffer, cachePath });
      } else {
        // ディスクに保存（通常は使用しないが、互換性のため）
        await transformer.toFile(cachePath);
        resolve({ cachePath });
      }
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * ImageMagickを使用したHEIC画像変換
 */
async function convertHeicWithImageMagick({
  fullPath,
  cachePath,
  quality,
  Photo_Size,
  memoryOnly,
}) {
  return new Promise((resolve, reject) => {
    const effortVal = getWebpEffort();
    const presetVal = getWebpPreset();
    const reductionEffortVal = getWebpReductionEffort();

    let resizeOpt = [];
    if (Photo_Size) {
      resizeOpt = ["-resize", `${Photo_Size}x${Photo_Size}>`];
    }

    const args = [
      fullPath,
      ...resizeOpt,
      "-quality",
      quality.toString(),
      "-define",
      `webp:effort=${effortVal}`,
      "-define",
      `webp:preset=${presetVal}`,
      "-define",
      `webp:reduction-effort=${reductionEffortVal}`,
      "webp:-",
    ];

    const magick = spawn(MAGICK_CMD, args);

    if (memoryOnly) {
      // メモリのみに保存（Bufferとして返す）
      const chunks = [];
      magick.stdout.on("data", (chunk) => {
        chunks.push(chunk);
      });
      magick.stdout.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, cachePath });
      });
      magick.stdout.on("error", (e) => reject(e));
    } else {
      // ディスクに保存（通常は使用しないが、互換性のため）
      const writeStream = fs.createWriteStream(cachePath);
      magick.stdout.pipe(writeStream);
      writeStream.on("finish", () => resolve({ cachePath }));
      writeStream.on("error", (e) => reject(e));
    }

    magick.stderr.on("data", (data) => {
      // ImageMagickのエラー出力は無視（通常の警告メッセージ）
    });

    magick.on("error", (e) => reject(e));
    magick.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ImageMagick process exited with code ${code}`));
      }
    });
  });
}

// Worker Threadのメッセージハンドラ
parentPort.on("message", async (message) => {
  try {
    const { type, data } = message;

    if (type === "convert") {
      // 単一ファイルの変換処理
      const result = await convertImage(data);
      parentPort.postMessage({ type: "success", data: result });
    } else if (type === "prefetch") {
      // 事前変換処理（複数ファイル）
      const { dirPath, fileName, activeCacheDir, quality, Photo_Size, cacheMinSize, imageExts, prefetchCount, memoryOnly } = data;
      
      try {
        // ディレクトリ内のファイルリストを取得
        const files = await fs.promises.readdir(dirPath);
        
        // ファイル名でソート（自然順序）
        files.sort((a, b) => {
          return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
        });

        // 現在のファイルのインデックスを取得
        const currentIndex = files.indexOf(fileName);
        if (currentIndex === -1) {
          return; // ファイルが見つからない場合はスキップ
        }

        // 前方（次の画像）のみを事前変換
        const startIndex = currentIndex + 1;
        const endIndex = Math.min(files.length, currentIndex + prefetchCount + 1);
        const adjacentFiles = files.slice(startIndex, endIndex);

        // 各ファイルを変換
        for (const file of adjacentFiles) {
          const adjacentPath = path.join(dirPath, file);
          const ext = path.extname(adjacentPath).toLowerCase();

          // 画像ファイルでない場合はスキップ
          if (!imageExts.includes(ext)) {
            continue;
          }

          try {
            // ファイル統計情報を取得
            const stat = await fs.promises.stat(adjacentPath).catch(() => null);
            if (!stat || !stat.isFile()) {
              continue;
            }

            // キャッシュキーを生成
            const keyData =
              adjacentPath +
              "|" +
              (Photo_Size ?? "o") +
              "|" +
              quality +
              "|" +
              String(stat.mtimeMs) +
              "|" +
              String(stat.size);
            const key = crypto.createHash("sha256").update(keyData, "utf8").digest("hex");
            const cachePath = path.join(activeCacheDir, key + ".webp");

            // 画像変換を実行
            const result = await convertImage({
              fullPath: adjacentPath,
              cachePath,
              quality,
              Photo_Size,
              memoryOnly,
            });

            // 変換結果をメインスレッドに送信
            // BufferはTransferableオブジェクトとして送信（メモリコピーを避ける）
            if (result && result.buffer && result.cachePath && Buffer.isBuffer(result.buffer)) {
              // BufferのArrayBufferをTransferableオブジェクトとして送信
              // これにより、メモリコピーを避けて効率的に送信できる
              const arrayBuffer = result.buffer.buffer.slice(
                result.buffer.byteOffset,
                result.buffer.byteOffset + result.buffer.byteLength
              );

              // gzip圧縮を試みる（圧縮機能が有効な場合）
              let compressedBuffer = null;
              if (getCompressionEnabled()) {
                try {
                  const compressed = await new Promise((resolve, reject) => {
                    zlib.gzip(
                      result.buffer,
                      {
                        level: 9,
                        memLevel: 9,
                        windowBits: 15,
                      },
                      (err, compressed) => {
                        if (err) reject(err);
                        else resolve(compressed);
                      }
                    );
                  });

                  // 圧縮効果を確認
                  const compressionRatio = compressed.length / result.buffer.length;
                  const threshold = getCompressionThreshold();

                  // 圧縮効果が閾値未満の場合のみ圧縮版を使用
                  if (compressionRatio < threshold) {
                    const compressedArrayBuffer = compressed.buffer.slice(
                      compressed.byteOffset,
                      compressed.byteOffset + compressed.byteLength
                    );
                    compressedBuffer = new Uint8Array(compressedArrayBuffer);
                  }
                } catch (e) {
                  // 圧縮エラーは無視（非圧縮版を使用）
                }
              }

              parentPort.postMessage(
                {
                  type: "prefetch_success",
                  data: {
                    buffer: new Uint8Array(arrayBuffer), // Uint8Arrayとして送信
                    cachePath: result.cachePath,
                    compressedBuffer: compressedBuffer, // 圧縮版（効果がある場合のみ）
                  },
                },
                compressedBuffer
                  ? [arrayBuffer, compressedBuffer.buffer] // Transferableオブジェクトとして送信（メモリコピーを避ける）
                  : [arrayBuffer]
              );
            }
          } catch (e) {
            // 個別ファイルの処理エラーは無視
          }
        }
      } catch (e) {
        // エラーは無視（ログなし）
      }
    } else {
      parentPort.postMessage({ type: "error", error: "Unknown message type" });
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error.message });
  }
});
