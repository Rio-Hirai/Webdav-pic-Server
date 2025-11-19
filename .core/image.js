// === 画像変換処理システムモジュール ===

/**
 * ======== 画像変換処理システム ========
 *
 * 高性能な画像変換処理を提供する関数群
 * - Sharpライブラリをメインエンジンとして使用
 * - ImageMagickをフォールバックとして使用
 * - ストリーミング処理によるメモリ効率化
 * - 原子的キャッシュ更新によるデータ整合性保証
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const stream = require("stream");
const { promisify } = require("util");
const { spawn } = require("child_process");
const sharp = require("sharp");
const pLimit = require("p-limit");
const {
  logger, // ロガー
  MAGICK_CMD, // ImageMagickコマンド
  getSharpPixelLimit, // Sharpのピクセル制限
  getImageMode, // 画像モード
  getMaxConcurrency, // 最大並列数
  getWebpEffort, // WebPのエンコード努力度
  getWebpEffortFast, // WebPの高速エンコード努力度
  getWebpPreset, // WebPのプリセット
  getWebpReductionEffort, // WebPの再圧縮努力度
} = require("./config"); // 設定値を取得

const PassThrough = stream.PassThrough; // パススルー
const pipeline = promisify(stream.pipeline); // パイプライン

/**
 * 並列処理制限とin-flight管理
 * 大量の画像変換リクエストに対する適切な並列制御を提供
 */
const inFlightConversions = new Map(); // in-flight変換の管理（重複変換防止）

// 初期並列数でpLimitを初期化
let conversionLimit = pLimit(getMaxConcurrency());

// 並列数を再初期化する関数（設定変更時に呼び出し）
function reinitializeConcurrency() {
  const newConcurrency = getMaxConcurrency();
  conversionLimit = pLimit(newConcurrency);
  logger.info(`[並列制御再初期化] 最大並列数: ${newConcurrency}`);
}

// 初回ログ出力
logger.info(
  `[画像変換並列制御] 最大並列数: ${getMaxConcurrency()}, in-flight管理: 有効`
);

/**
 * 並列制限付き画像変換・レスポンス送信関数
 * in-flight重複防止と並列数制限を適用
 */
async function convertAndRespondWithLimit(params) {
  const {
    fullPath, // 変換対象画像のフルパス
    displayPath, // 表示用パス（ログ出力用）
    cachePath, // キャッシュファイルパス（null=キャッシュなし）
    quality, // WebP変換品質（10-100）
    Photo_Size, // リサイズサイズ（null=リサイズなし）
    res, // HTTPレスポンスオブジェクト
    clientIP, // クライアントIP
  } = params; // パラメータを分解

  // キャッシュキー生成（重複変換検出用）
  const cacheKey = `${fullPath}-${quality}-${Photo_Size}`;

  // in-flight重複チェック
  if (inFlightConversions.has(cacheKey)) {
    logger.info(`[重複変換防止] 同じ画像の変換が進行中: ${displayPath}`);

    // 既存の変換完了を待つ
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        if (!inFlightConversions.has(cacheKey)) {
          clearInterval(checkInterval);
          try {
            // キャッシュがある場合はキャッシュから返す
            if (cachePath && fs.existsSync(cachePath)) {
              const stream = fs.createReadStream(cachePath);
              res.setHeader("Content-Type", "image/webp");
              stream.pipe(res);
              stream.on("end", resolve);
              stream.on("error", () => resolve());
              return;
            }
            // キャッシュが無い場合は改めて変換を実行（短時間で完了する想定）
            await conversionLimit(() => convertAndRespond(params));
          } catch (e) {
            try {
              res.writeHead(500);
              res.end("Internal error");
            } catch (_) {}
          }
          return resolve();
        }
      }, 100); // 100ms間隔でチェック
    });
  }

  // in-flight管理に追加
  inFlightConversions.set(cacheKey, { startTime: Date.now(), displayPath });

  try {
    // 並列制限を適用して変換実行
    const result = await conversionLimit(() => convertAndRespond(params));

    // in-flight管理から削除
    inFlightConversions.delete(cacheKey);

    return result;
  } catch (error) {
    // エラー時もin-flight管理から削除
    inFlightConversions.delete(cacheKey);
    throw error;
  }
}

/**
 * 画像変換・レスポンス送信関数
 * 指定された画像ファイルをWebP形式に変換し、HTTPレスポンスとして送信
 *
 * @param {Object} params - 変換パラメータ
 * @param {string} params.fullPath - 変換対象画像のフルパス
 * @param {string} params.displayPath - 表示用パス（ログ出力用）
 * @param {string|null} params.cachePath - キャッシュファイルパス（null=キャッシュなし）
 * @param {number} params.quality - WebP変換品質（10-100）
 * @param {number|null} params.Photo_Size - リサイズサイズ（null=リサイズなし）
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
async function convertAndRespond({
  fullPath,
  displayPath,
  cachePath,
  quality,
  Photo_Size,
  res,
  clientIP,
}) {
  // 画像処理モードを取得（1=高速処理、2=バランス処理、3=高圧縮処理）
  const imageMode = getImageMode();
  const isFast = imageMode === 1; // 高速処理モードかどうかを判定

  // HEIC画像の検出とImageMagickへの直接ルーティング
  const fileExt = path.extname(fullPath).toLowerCase();
  const isHeicImage = fileExt === ".heic" || fileExt === ".heif";

  if (isHeicImage) {
    logger.info(`[HEIC画像検出] ImageMagickに直接ルーティング: ${displayPath}`);
    return convertHeicWithImageMagick({
      fullPath,
      displayPath,
      cachePath,
      quality,
      Photo_Size,
      res,
      clientIP,
    });
  }

  // Promise を返すことで呼び出し側が完了を待てるようにする
  return new Promise(async (resolve, reject) => {
    /**
     * 原子的キャッシュ更新のための一時ファイルパス生成
     * キャッシュファイルの書き込み中に他のプロセスが読み込むことを防ぐ
     */
    const tmpPath = cachePath
      ? cachePath + `.tmp-${crypto.randomBytes(6).toString("hex")}`
      : null;
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

      // クライアント切断時にパイプラインを破棄してリソースを解放
      try {
        if (res && typeof res.once === "function") {
          res.once("close", () => {
            try {
              if (transformer && typeof transformer.destroy === "function")
                transformer.destroy();
            } catch (_) {}
          });
        }
      } catch (_) {}

      // 回転補正は高速処理モードでは行わない（パフォーマンス優先）
      if (!isFast) transformer = transformer.rotate(); // EXIFに基づく自動回転

      /**
       * リサイズ処理の設定
       * Photo_Size が指定されている場合のみリサイズを実行
       *
       * 技術的詳細:
       * - 高速処理モード: 幅基準の単純リサイズ（処理速度優先）
       * - バランス/高圧縮モード: 縦横比較による最適リサイズ（見た目優先）
       * - withoutEnlargement: 元画像より大きくしない制限
       * - メタデータ取得: 画像サイズ情報の動的取得
       */
      if (Photo_Size) {
        if (isFast) {
          // 高速処理モード: 幅を基準に単純リサイズ（処理速度優先）
          transformer = transformer.resize({
            width: Photo_Size, // 指定幅にリサイズ
            withoutEnlargement: true, // 元画像より大きくしない
          });
        } else {
          // バランス/高圧縮モード: 縦横を比較して短辺に合わせる（見た目優先）
          const meta = await transformer.metadata(); // メタデータ取得
          if (meta.width != null && meta.height != null) {
            // サイズ情報が取得できた場合のみ
            if (meta.width < meta.height) {
              // 短辺が幅の場合
              transformer = transformer.resize({
                width: Photo_Size, // 指定幅にリサイズ
                withoutEnlargement: true, // 元画像より大きくしない
              });
            } else {
              transformer = transformer.resize({
                // heightを基準にリサイズ
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
       * - quality: 圧縮品質（10-100の範囲）
       * - effort: 圧縮努力レベル（0=高速、1=標準）
       * - nearLossless: 準可逆圧縮の無効化
       * - smartSubsample: スマートサブサンプリングの有効/無効
       */
      // effort は設定から取得。高速モードと通常モードで別々の値を使える
      const effortVal = isFast ? getWebpEffortFast() : getWebpEffort();
      const presetVal = getWebpPreset(); // プリセット設定を取得
      const reductionEffortVal = getWebpReductionEffort(); // reduction effort設定を取得
      transformer = transformer.webp({
        quality, // 品質設定（10-100）
        effort: effortVal, // 圧縮努力レベル（0=速い〜6=高圧縮）
        preset: presetVal, // WebPプリセット設定
        nearLossless: false, // 準可逆圧縮は無効
        smartSubsample: isFast ? false : true, // スマートサブサンプリング（高速処理では無効、バランス/高圧縮処理では有効）
        reductionEffort: reductionEffortVal, // WebP reduction effort設定
      });

      // Sharp変換にタイムアウトを設定（5秒）
      const sharpTimeout = setTimeout(() => {
        logger.warn(
          `[Sharp変換タイムアウト] ${displayPath} - 5秒でタイムアウト`
        );
        transformer.destroy();
        onErrorFallback(new Error("Sharp conversion timeout"));
      }, 5000);

      // メモリ使用量の監視（大量画像処理時の診断用）- 初回のみ詳細ログ
      const memUsage = process.memoryUsage();
      const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const pixelLimit = getSharpPixelLimit();

      // 初回のみ詳細ログを出力
      if (!global.imageConversionLogged) {
        logger.info(
          `[変換実行] ${displayPath} → ${
            cachePath ?? "(no cache)"
          } (q=${quality}, preset=${presetVal}, reductionEffort=${reductionEffortVal}) [メモリ: ${memUsageMB}MB, ピクセル制限: ${pixelLimit} (型: ${typeof pixelLimit})]`
        );
        global.imageConversionLogged = true;
      } else {
        logger.info(
          `[変換実行] ${displayPath} → ${
            cachePath ?? "(no cache)"
          } (q=${quality}, preset=${presetVal}, reductionEffort=${reductionEffortVal})`
        );
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
        const errorCode = err && err.code ? err.code : "unknown";

        if (errorMsg.includes("Premature close")) {
          logger.info(
            `[Sharp Premature close - スキップ] ${displayPath} : Premature close (ストリーム終了) - エラーコード: ${errorCode}`
          );
          // Premature closeエラーの場合は直接スキップ（ImageMagickフォールバックしない）
          if (res && !res.headersSent) {
            res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Request cancelled due to stream error");
          }
          return resolve();
        } else {
          logger.warn(
            `[Sharp失敗→ImageMagick] ${displayPath} : ${errorMsg} (エラーコード: ${errorCode})`
          );

          // 特定のエラーに対しては詳細情報を出力
          if (errorCode === "ENOENT") {
            logger.error(
              `[Sharp失敗詳細] ファイルが見つかりません: ${fullPath}`
            );
          } else if (errorCode === "EACCES") {
            logger.error(
              `[Sharp失敗詳細] ファイルアクセス権限がありません: ${fullPath}`
            );
          } else if (errorCode === "EMFILE" || errorCode === "ENFILE") {
            logger.error(
              `[Sharp失敗詳細] ファイルディスクリプタ不足: ${fullPath}`
            );
          } else if (errorMsg.includes("Input file is missing")) {
            logger.error(
              `[Sharp失敗詳細] 入力ファイルが存在しません: ${fullPath}`
            );
          } else if (errorMsg.includes("limitInputPixels")) {
            logger.error(
              `[Sharp失敗詳細] ピクセル制限超過: ${fullPath} (制限: ${getSharpPixelLimit()})`
            );
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
        const resizeOpt = Photo_Size
          ? ["-resize", `${Photo_Size}x${Photo_Size}`]
          : []; // リサイズオプション
        const magick = spawn(MAGICK_CMD, [
          fullPath,
          ...resizeOpt,
          "-quality",
          `${quality}`,
          "webp:-",
        ]); // ImageMagickプロセスを起動

        // ImageMagickプロセスのエラーハンドリング
        magick.on("error", (err) => {
          logger.error(`[ImageMagick変換失敗] ${fullPath}: ${err}`); // エラーログを出力

          // ImageMagick失敗時は元画像を直接送信
          logger.info(`[ImageMagick失敗→元画像送信] ${displayPath}`);

          // HTTPヘッダー設定（まだ送信されていない場合）
          if (!res.headersSent) {
            // 元画像のContent-Typeを設定
            const fileExt = path.extname(fullPath).toLowerCase();
            let contentType = "application/octet-stream";
            if (fileExt === ".jpg" || fileExt === ".jpeg")
              contentType = "image/jpeg";
            else if (fileExt === ".png") contentType = "image/png";
            else if (fileExt === ".gif") contentType = "image/gif";
            else if (fileExt === ".webp") contentType = "image/webp";
            else if (fileExt === ".bmp") contentType = "image/bmp";
            else if (fileExt === ".tiff" || fileExt === ".tif")
              contentType = "image/tiff";

            res.setHeader("Content-Type", contentType);
          }

          // 元画像ファイルを直接ストリーミング
          const fileStream = fs.createReadStream(fullPath);
          fileStream.pipe(res);

          fileStream.on("error", (streamErr) => {
            logger.error(
              `[元画像送信失敗] ${displayPath}: ${streamErr.message}`
            );
            if (!res.headersSent) res.writeHead(500);
            res.end("Failed to read original image");
            return reject(streamErr);
          });

          fileStream.on("end", () => {
            logger.info(`[変換完了(元画像)] ${displayPath}`);
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
              if (e.message && e.message.includes("Premature close")) {
                logger.info(`[magick->tmp pipeline] ${e.message}`);
                // Premature closeの場合はImageMagickプロセスを終了
                if (magick && !magick.killed) {
                  try {
                    magick.kill("SIGTERM");
                    logger.info(
                      `[ImageMagick強制終了(Premature close)] ${displayPath}`
                    );
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
              logger.info(
                `[ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
              );

              // HTTPヘッダー設定（まだ送信されていない場合）
              if (!res.headersSent) {
                // 元画像のContent-Typeを設定
                const fileExt = path.extname(fullPath).toLowerCase();
                let contentType = "application/octet-stream";
                if (fileExt === ".jpg" || fileExt === ".jpeg")
                  contentType = "image/jpeg";
                else if (fileExt === ".png") contentType = "image/png";
                else if (fileExt === ".gif") contentType = "image/gif";
                else if (fileExt === ".webp") contentType = "image/webp";
                else if (fileExt === ".bmp") contentType = "image/bmp";
                else if (fileExt === ".tiff" || fileExt === ".tif")
                  contentType = "image/tiff";

                res.setHeader("Content-Type", contentType);
              }

              // 元画像ファイルを直接ストリーミング
              const fileStream = fs.createReadStream(fullPath);
              fileStream.pipe(res);

              fileStream.on("error", (streamErr) => {
                logger.error(
                  `[元画像送信失敗] ${displayPath}: ${streamErr.message}`
                );
                if (!res.headersSent) res.writeHead(500);
                res.end("Failed to read original image");
                return reject(streamErr);
              });

              fileStream.on("end", () => {
                logger.info(`[変換完了(元画像)] ${displayPath}`);
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
                  magick.kill("SIGTERM");
                  logger.info(`[ImageMagick強制終了] ${displayPath}`);
                } catch (e) {
                  // プロセス終了エラーは無視
                }
              }

              return resolve();
            });
          } catch (writeError) {
            logger.warn(
              `[キャッシュディレクトリ作成失敗] ${writeError.message}`
            );
            // キャッシュなしでレスポンス継続
            pipeline(magick.stdout, res).catch((err) => {
              // Premature closeエラーは頻発するため、ログレベルを調整
              if (err.message && err.message.includes("Premature close")) {
                logger.info(`[magick->res pipeline] ${err.message}`);
                // Premature closeの場合はImageMagickプロセスを終了
                if (magick && !magick.killed) {
                  try {
                    magick.kill("SIGTERM");
                    logger.info(
                      `[ImageMagick強制終了(Premature close)] ${displayPath}`
                    );
                  } catch (killErr) {
                    // プロセス終了エラーは無視
                  }
                }
              } else {
                logger.error(`[magick->res pipeline error] ${err.message}`);

                // ImageMagickパイプラインエラー時は元画像を送信
                logger.info(
                  `[ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
                );

                // HTTPヘッダー設定（まだ送信されていない場合）
                if (!res.headersSent) {
                  // 元画像のContent-Typeを設定
                  const fileExt = path.extname(fullPath).toLowerCase();
                  let contentType = "application/octet-stream";
                  if (fileExt === ".jpg" || fileExt === ".jpeg")
                    contentType = "image/jpeg";
                  else if (fileExt === ".png") contentType = "image/png";
                  else if (fileExt === ".gif") contentType = "image/gif";
                  else if (fileExt === ".webp") contentType = "image/webp";
                  else if (fileExt === ".bmp") contentType = "image/bmp";
                  else if (fileExt === ".tiff" || fileExt === ".tif")
                    contentType = "image/tiff";

                  res.setHeader("Content-Type", contentType);
                }

                // 元画像ファイルを直接ストリーミング
                const fileStream = fs.createReadStream(fullPath);
                fileStream.pipe(res);

                fileStream.on("error", (streamErr) => {
                  logger.error(
                    `[元画像送信失敗] ${displayPath}: ${streamErr.message}`
                  );
                  if (!res.headersSent) res.writeHead(500);
                  res.end("Failed to read original image");
                  return reject(streamErr);
                });

                fileStream.on("end", () => {
                  logger.info(`[変換完了(元画像)] ${displayPath}`);
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
            if (e.message && e.message.includes("Premature close")) {
              logger.info(`[magick->res pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill("SIGTERM");
                  logger.info(
                    `[ImageMagick強制終了(Premature close)] ${displayPath}`
                  );
                } catch (killErr) {
                  // プロセス終了エラーは無視
                }
              }
            } else {
              logger.error(`[magick->res pipeline error] ${e.message}`);

              // ImageMagickパイプラインエラー時は元画像を送信
              logger.info(
                `[ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
              );

              // HTTPヘッダー設定（まだ送信されていない場合）
              if (!res.headersSent) {
                // 元画像のContent-Typeを設定
                const fileExt = path.extname(fullPath).toLowerCase();
                let contentType = "application/octet-stream";
                if (fileExt === ".jpg" || fileExt === ".jpeg")
                  contentType = "image/jpeg";
                else if (fileExt === ".png") contentType = "image/png";
                else if (fileExt === ".gif") contentType = "image/gif";
                else if (fileExt === ".webp") contentType = "image/webp";
                else if (fileExt === ".bmp") contentType = "image/bmp";
                else if (fileExt === ".tiff" || fileExt === ".tif")
                  contentType = "image/tiff";

                res.setHeader("Content-Type", contentType);
              }

              // 元画像ファイルを直接ストリーミング
              const fileStream = fs.createReadStream(fullPath);
              fileStream.pipe(res);

              fileStream.on("error", (streamErr) => {
                logger.error(
                  `[元画像送信失敗] ${displayPath}: ${streamErr.message}`
                );
                if (!res.headersSent) res.writeHead(500);
                res.end("Failed to read original image");
                return reject(streamErr);
              });

              fileStream.on("end", () => {
                logger.info(`[変換完了(元画像)] ${displayPath}`);
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
          logger.info(
            `[変換完了(ImageMagick)] ${displayPath} (サイズ: ${magickResponseSize.toLocaleString()} bytes)`
          ); // ImageMagick変換完了ログを出力
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
          logger.warn(
            `[Premature close検出(fallback)] ${displayPath} - 強制完了`
          );

          // ImageMagickプロセスを強制終了
          if (magick && !magick.killed) {
            try {
              magick.kill("SIGTERM");
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
        if (errorMsg.includes("Premature close")) {
          logger.info(`[Sharp Premature close - スキップ] ${displayPath}`);
          if (res && !res.headersSent) {
            res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Request cancelled due to stream error");
          }
          return resolve();
        }

        onErrorFallback(err); // その他のSharp変換エラー時にフォールバック
      });
      pass.on("error", (err) => {
        clearTimeout(sharpTimeout); // タイムアウトをクリア
        const errorMsg = err && err.message ? err.message : err;

        // Premature closeエラーの場合は直接スキップ（フォールバックしない）
        if (errorMsg.includes("Premature close")) {
          logger.info(
            `[PassThrough Premature close - スキップ] ${displayPath}`
          );
          if (res && !res.headersSent) {
            res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Request cancelled due to stream error");
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
          if (e.message && e.message.includes("Premature close")) {
            logger.info(`[cache write pipeline] ${e.message}`);
          } else {
            logger.error(`[cache write pipeline error] ${e.message}`);
          }
          // キャッシュ書き込み失敗時はレスポンス継続
        }); // キャッシュ書き込み
        pipeline(pass, res).catch((e) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (e.message && e.message.includes("Premature close")) {
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
              await fs.promises.rename(tmpPath, cachePath).catch(async (e) => {
                // 一時ファイルをキャッシュファイルにリネーム
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

          logger.info(
            `[変換完了(Sharp)] ${displayPath} (サイズ: ${responseSize.toLocaleString()} bytes)`
          ); // Sharp変換完了ログを出力
          res.end(); // レスポンスを終了
          return resolve(); // 呼び出し元に完了を伝播
        });
      } else {
        /**
         * キャッシュなしの場合の処理
         * 直接レスポンスにストリーミング
         */
        pass.on("data", (chunk) => {
          if (!wroteHeader) {
            // 最初のチャンク受信時にHTTPヘッダー送信（チャンク転送）
            res.writeHead(200, {
              // レスポンスヘッダーを設定
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
          if (e.message && e.message.includes("Premature close")) {
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

          logger.info(
            `[変換完了(Sharp)] ${fullPath} (サイズ: ${responseSize.toLocaleString()} bytes)`
          ); // Sharp変換完了ログを出力
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
          logger.warn(
            `[Premature close検出(キャッシュなし)] ${displayPath} - 強制完了`
          );
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
      const resizeOpt = Photo_Size
        ? ["-resize", `${Photo_Size}x${Photo_Size}`]
        : []; // リサイズオプション
      const magick = spawn(MAGICK_CMD, [
        fullPath,
        ...resizeOpt,
        "-quality",
        `${quality}`,
        "webp:-",
      ]); // ImageMagickプロセスを起動

      // ImageMagickプロセスのエラーハンドリング
      magick.on("error", (err) => {
        logger.error(`[ImageMagick変換失敗] ${displayPath}: ${err}`); // エラーログを出力
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
            if (e.message && e.message.includes("Premature close")) {
              logger.info(`[magick->tmp pipeline] ${e.message}`);
              // Premature closeの場合はImageMagickプロセスを終了
              if (magick && !magick.killed) {
                try {
                  magick.kill("SIGTERM");
                  logger.info(
                    `[ImageMagick強制終了(Premature close)] ${displayPath}`
                  );
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
                logger.warn(
                  `[初期化エラー時キャッシュリネーム失敗] ${e.message}`
                );
              }); // リネーム失敗は警告ログ出力
            } catch (e) {
              logger.warn(
                `[初期化エラー時キャッシュリネーム例外] ${e.message}`
              );
            }
          });

          // 書き込みストリームエラー処理
          writeStream.on("error", (e) => {
            logger.warn(
              `[初期化エラー時キャッシュ書き込みエラー] ${e.message}`
            );
          });
        } catch (writeError) {
          logger.warn(
            `[初期化エラー時キャッシュディレクトリ作成失敗] ${writeError.message}`
          );
        }
      } else {
        // キャッシュなしの場合は直接レスポンスにストリーミング
        pipeline(magick.stdout, res).catch((e) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (e.message && e.message.includes("Premature close")) {
            logger.info(`[magick->res pipeline] ${e.message}`);
            // Premature closeの場合はImageMagickプロセスを終了
            if (magick && !magick.killed) {
              try {
                magick.kill("SIGTERM");
                logger.info(
                  `[ImageMagick強制終了(Premature close)] ${displayPath}`
                );
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
        logger.info(
          `[変換完了(ImageMagick)] ${displayPath} (サイズ: ${initErrorResponseSize.toLocaleString()} bytes)`
        ); // ImageMagick変換完了ログを出力
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
        logger.warn(
          `[Premature close検出(初期化エラー)] ${displayPath} - 強制完了`
        );

        // ImageMagickプロセスを強制終了
        if (magick && !magick.killed) {
          try {
            magick.kill("SIGTERM");
            logger.info(`[ImageMagick強制終了] ${displayPath}`);
          } catch (e) {
            // プロセス終了エラーは無視
          }
        }

        return resolve();
      });
    }
  });
}

/**
 * HEIC画像専用ImageMagick変換関数
 * HEIC画像を一発でImageMagickにルーティングしてWebP変換
 *
 * @param {Object} params - 変換パラメータ
 * @param {string} params.fullPath - 変換対象HEIC画像のフルパス
 * @param {string} params.displayPath - 表示用パス（ログ出力用）
 * @param {string|null} params.cachePath - キャッシュファイルパス（null=キャッシュなし）
 * @param {number} params.quality - WebP変換品質（10-100）
 * @param {number|null} params.Photo_Size - リサイズサイズ（null=リサイズなし）
 * @param {Object} params.res - HTTPレスポンスオブジェクト
 * @param {string} params.clientIP - クライアントIP（ログ用）
 *
 * @returns {Promise<void>} 変換完了時にresolve
 */
async function convertHeicWithImageMagick({
  fullPath,
  displayPath,
  cachePath,
  quality,
  Photo_Size,
  res,
  clientIP,
}) {
  return new Promise(async (resolve, reject) => {
    // 画像処理モードを取得（Sharpと同じ設定を使用）
    const imageMode = getImageMode();
    const isFast = imageMode === 1; // 高速処理モードかどうかを判定

    /**
     * 原子的キャッシュ更新のための一時ファイルパス生成
     * キャッシュファイルの書き込み中に他のプロセスが読み込むことを防ぐ
     */
    const tmpPath = cachePath
      ? cachePath + `.tmp-${crypto.randomBytes(6).toString("hex")}`
      : null;

    // Sharpと同じWebP設定を取得
    const effortVal = isFast ? getWebpEffortFast() : getWebpEffort();
    const presetVal = getWebpPreset();
    const reductionEffortVal = getWebpReductionEffort();

    // メモリ使用量の監視（Sharpと同じ診断情報）
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    // HEIC変換開始の詳細ログ
    logger.info(
      `[HEIC変換開始] ${displayPath} → ${
        cachePath ?? "(no cache)"
      } (q=${quality}, preset=${presetVal}, reductionEffort=${reductionEffortVal}, effort=${effortVal}, mode=${imageMode}) [メモリ: ${memUsageMB}MB]`
    );

    /**
     * ImageMagickコマンドライン引数の構築（Sharpの設定を流用）
     * - resize: Photo_Sizeが指定されている場合のみリサイズ（Sharpと同じロジック）
     * - quality: WebP品質設定（Sharpと同じ）
     * - webp:-: 標準出力にWebP形式で出力
     * - SharpのWebP設定をImageMagickオプションに変換
     *
     * 技術的詳細:
     * - spawn使用: ストリーミング処理によるメモリ効率化
     * - 標準出力: パイプによるデータ転送
     * - エラーハンドリング: プロセス失敗時の適切な処理
     * - リソース管理: プロセス終了時の自動クリーンアップ
     */
    let resizeOpt = [];
    if (Photo_Size) {
      if (isFast) {
        // 高速処理モード: 幅を基準に単純リサイズ（Sharpと同じロジック）
        resizeOpt = ["-resize", `${Photo_Size}x`];
      } else {
        // バランス/高圧縮モード: 縦横を比較して短辺に合わせる（Sharpと同じロジック）
        try {
          // ImageMagickでメタデータを取得してサイズ判定
          logger.info(
            `[HEIC メタデータ取得] ${displayPath} - サイズ判定のためidentify実行`
          );
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

          await new Promise((identifyResolve, identifyReject) => {
            identifyCmd.on("close", (code) => {
              if (code === 0) {
                const [width, height] = identifyOutput
                  .trim()
                  .split("x")
                  .map(Number);
                logger.info(
                  `[HEIC メタデータ取得完了] ${displayPath} - サイズ: ${width}x${height}`
                );
                if (width < height) {
                  // 短辺が幅の場合
                  resizeOpt = ["-resize", `${Photo_Size}x`];
                  logger.info(`[HEIC リサイズ設定] 幅基準: ${Photo_Size}x`);
                } else {
                  // 短辺が高さの場合
                  resizeOpt = ["-resize", `x${Photo_Size}`];
                  logger.info(`[HEIC リサイズ設定] 高さ基準: x${Photo_Size}`);
                }
                identifyResolve();
              } else {
                // メタデータ取得失敗時は幅基準でリサイズ
                logger.warn(
                  `[HEIC メタデータ取得失敗] ${displayPath} - 幅基準でリサイズ`
                );
                resizeOpt = ["-resize", `${Photo_Size}x`];
                identifyResolve();
              }
            });
            identifyCmd.on("error", (err) => {
              // エラー時は幅基準でリサイズ
              logger.warn(
                `[HEIC メタデータ取得エラー] ${displayPath} - ${err.message}, 幅基準でリサイズ`
              );
              resizeOpt = ["-resize", `${Photo_Size}x`];
              identifyResolve();
            });
          });
        } catch (e) {
          // 例外時は幅基準でリサイズ
          logger.warn(
            `[HEIC メタデータ取得例外] ${displayPath} - ${e.message}, 幅基準でリサイズ`
          );
          resizeOpt = ["-resize", `${Photo_Size}x`];
        }
      }
    }

    // ImageMagickのWebPオプション構築（Sharpの設定を反映）
    const webpOptions = [
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
      webpOptions.push("-define", "webp:smart-subsample=true");
    }

    const magick = spawn(MAGICK_CMD, [
      fullPath,
      ...resizeOpt,
      ...webpOptions,
      "webp:-",
    ]); // ImageMagickプロセスを起動

    // ImageMagickプロセス開始のログ
    logger.info(
      `[HEIC ImageMagick起動] コマンド: ${MAGICK_CMD} ${[
        fullPath,
        ...resizeOpt,
        ...webpOptions,
        "webp:-",
      ].join(" ")}`
    );

    // ImageMagickプロセスのエラーハンドリング
    magick.on("error", (err) => {
      logger.error(`[HEIC ImageMagick変換失敗] ${fullPath}: ${err}`); // エラーログを出力

      // ImageMagick失敗時は元画像を直接送信
      logger.info(`[HEIC ImageMagick失敗→元画像送信] ${displayPath}`);

      // HTTPヘッダー設定（まだ送信されていない場合）
      if (!res.headersSent) {
        res.setHeader("Content-Type", "image/heic"); // HEIC画像のMIMEタイプ
      }

      // 元画像ファイルを直接ストリーミング
      const fileStream = fs.createReadStream(fullPath);
      fileStream.pipe(res);

      fileStream.on("error", (streamErr) => {
        logger.error(
          `[HEIC元画像送信失敗] ${displayPath}: ${streamErr.message}`
        );
        if (!res.headersSent) res.writeHead(500);
        res.end("Failed to read original HEIC image");
        return reject(streamErr);
      });

      fileStream.on("end", () => {
        logger.info(`[HEIC変換完了(元画像)] ${displayPath}`);
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
          if (e.message && e.message.includes("Premature close")) {
            logger.info(`[HEIC magick->tmp pipeline] ${e.message}`);
            // Premature closeの場合はImageMagickプロセスを終了
            if (magick && !magick.killed) {
              try {
                magick.kill("SIGTERM");
                logger.info(
                  `[HEIC ImageMagick強制終了(Premature close)] ${displayPath}`
                );
              } catch (killErr) {
                // プロセス終了エラーは無視
              }
            }
          } else {
            logger.error(`[HEIC magick->tmp pipeline error] ${e.message}`);
          }
          // キャッシュ書き込み失敗時はキャッシュなしで続行
        });
        magick.stdout.pipe(res, { end: false }); // レスポンスは手動で終了

        // ImageMagickの標準出力エラーハンドリング
        magick.stdout.on("error", (err) => {
          logger.error(`[HEIC magick->res pipeline error] ${err.message}`);

          // ImageMagickパイプラインエラー時は元画像を送信
          logger.info(
            `[HEIC ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
          );

          // HTTPヘッダー設定（まだ送信されていない場合）
          if (!res.headersSent) {
            res.setHeader("Content-Type", "image/heic");
          }

          // 元画像ファイルを直接ストリーミング
          const fileStream = fs.createReadStream(fullPath);
          fileStream.pipe(res);

          fileStream.on("error", (streamErr) => {
            logger.error(
              `[HEIC元画像送信失敗] ${displayPath}: ${streamErr.message}`
            );
            if (!res.headersSent) res.writeHead(500);
            res.end("Failed to read original HEIC image");
            return reject(streamErr);
          });

          fileStream.on("end", () => {
            logger.info(`[HEIC変換完了(元画像)] ${displayPath}`);
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
            logger.warn(`[HEICキャッシュリネーム失敗] ${e.message}`);
          }
        });

        // 書き込みストリームエラー処理
        writeStream.on("error", (e) => {
          logger.warn(`[HEICキャッシュ書き込みエラー] ${e.message}`);
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
          logger.warn(`[HEIC Premature close検出] ${displayPath} - 強制完了`);

          // ImageMagickプロセスを強制終了
          if (magick && !magick.killed) {
            try {
              magick.kill("SIGTERM");
              logger.info(`[HEIC ImageMagick強制終了] ${displayPath}`);
            } catch (e) {
              // プロセス終了エラーは無視
            }
          }

          return resolve();
        });
      } catch (writeError) {
        logger.warn(
          `[HEICキャッシュディレクトリ作成失敗] ${writeError.message}`
        );
        // キャッシュなしでレスポンス継続
        pipeline(magick.stdout, res).catch((err) => {
          // Premature closeエラーは頻発するため、ログレベルを調整
          if (err.message && err.message.includes("Premature close")) {
            logger.info(`[HEIC magick->res pipeline] ${err.message}`);
            // Premature closeの場合はImageMagickプロセスを終了
            if (magick && !magick.killed) {
              try {
                magick.kill("SIGTERM");
                logger.info(
                  `[HEIC ImageMagick強制終了(Premature close)] ${displayPath}`
                );
              } catch (killErr) {
                // プロセス終了エラーは無視
              }
            }
          } else {
            logger.error(`[HEIC magick->res pipeline error] ${err.message}`);

            // ImageMagickパイプラインエラー時は元画像を送信
            logger.info(
              `[HEIC ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
            );

            // HTTPヘッダー設定（まだ送信されていない場合）
            if (!res.headersSent) {
              res.setHeader("Content-Type", "image/heic");
            }

            // 元画像ファイルを直接ストリーミング
            const fileStream = fs.createReadStream(fullPath);
            fileStream.pipe(res);

            fileStream.on("error", (streamErr) => {
              logger.error(
                `[HEIC元画像送信失敗] ${displayPath}: ${streamErr.message}`
              );
              if (!res.headersSent) res.writeHead(500);
              res.end("Failed to read original HEIC image");
              return reject(streamErr);
            });

            fileStream.on("end", () => {
              logger.info(`[HEIC変換完了(元画像)] ${displayPath}`);
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
        if (e.message && e.message.includes("Premature close")) {
          logger.info(`[HEIC magick->res pipeline] ${e.message}`);
          // Premature closeの場合はImageMagickプロセスを終了
          if (magick && !magick.killed) {
            try {
              magick.kill("SIGTERM");
              logger.info(
                `[HEIC ImageMagick強制終了(Premature close)] ${displayPath}`
              );
            } catch (killErr) {
              // プロセス終了エラーは無視
            }
          }
        } else {
          logger.error(`[HEIC magick->res pipeline error] ${e.message}`);

          // ImageMagickパイプラインエラー時は元画像を送信
          logger.info(
            `[HEIC ImageMagickパイプラインエラー→元画像送信] ${displayPath}`
          );

          // HTTPヘッダー設定（まだ送信されていない場合）
          if (!res.headersSent) {
            res.setHeader("Content-Type", "image/heic");
          }

          // 元画像ファイルを直接ストリーミング
          const fileStream = fs.createReadStream(fullPath);
          fileStream.pipe(res);

          fileStream.on("error", (streamErr) => {
            logger.error(
              `[HEIC元画像送信失敗] ${displayPath}: ${streamErr.message}`
            );
            if (!res.headersSent) res.writeHead(500);
            res.end("Failed to read original HEIC image");
            return reject(streamErr);
          });

          fileStream.on("end", () => {
            logger.info(`[HEIC変換完了(元画像)] ${displayPath}`);
            res.end();
            return resolve();
          });
        }
      }); // レスポンスはパイプラインで自動終了
    }

    // 変換完了時の処理
    let heicResponseSize = 0; // HEIC ImageMagickレスポンスサイズ
    let chunkCount = 0; // チャンク数をカウント
    magick.stdout.on("data", (chunk) => {
      heicResponseSize += chunk.length; // レスポンスサイズを累計
      chunkCount++;
    });
    magick.stdout.on("end", () => {
      // 変換完了の詳細ログ
      const compressionRatio =
        heicResponseSize > 0
          ? Math.round(
              (1 -
                heicResponseSize /
                  (Photo_Size ? Photo_Size * Photo_Size * 3 : 1000000)) *
                100
            )
          : 0;
      logger.info(
        `[HEIC変換完了(ImageMagick)] ${displayPath} (サイズ: ${heicResponseSize.toLocaleString()} bytes, チャンク数: ${chunkCount}, 圧縮率: ${compressionRatio}%, 設定: q=${quality}, effort=${effortVal}, preset=${presetVal})`
      );
      res.end(); // レスポンスを終了
      return resolve(); // 呼び出し元に完了を伝播
    });

    // Premature closeエラー対策
    res.on("close", () => {
      if (!res.headersSent || res.writableEnded) {
        // レスポンスが正常に終了した場合は何もしない
        return;
      }
      // Premature closeの場合は強制的にresolveを呼ぶ
      logger.warn(`[HEIC Premature close検出] ${displayPath} - 強制完了`);

      // ImageMagickプロセスを強制終了
      if (magick && !magick.killed) {
        try {
          magick.kill("SIGTERM");
          logger.info(`[HEIC ImageMagick強制終了] ${displayPath}`);
        } catch (e) {
          // プロセス終了エラーは無視
        }
      }

      return resolve();
    });
  });
}

let inFlightMonitorInterval = null;

/**
 * in-flight状況の監視とクリーンアップ
 * 長時間残っている変換処理を検出・クリーンアップ
 */
function startInFlightMonitoring() {
  inFlightMonitorInterval = setInterval(() => {
    const now = Date.now();
    const timeout = 30000; // 30秒でタイムアウト

    for (const [cacheKey, info] of inFlightConversions.entries()) {
      if (now - info.startTime > timeout) {
        logger.warn(
          `[in-flightタイムアウト] 長時間残っている変換をクリーンアップ: ${info.displayPath}`
        );
        inFlightConversions.delete(cacheKey);
      }
    }

    // 定期的にin-flight状況をログ出力
    if (inFlightConversions.size > 0) {
      logger.info(
        `[in-flight状況] 進行中の変換: ${
          inFlightConversions.size
        }/${getMaxConcurrency()}`
      );
    }
  }, 10000); // 10秒間隔でチェック
}

function stopInFlightMonitoring() {
  if (inFlightMonitorInterval) {
    clearInterval(inFlightMonitorInterval);
    inFlightMonitorInterval = null;
  }
}

// in-flight監視を開始
startInFlightMonitoring();

module.exports = {
  convertAndRespond,
  convertAndRespondWithLimit,
  convertHeicWithImageMagick,
  reinitializeConcurrency,
  stopInFlightMonitoring,
};
