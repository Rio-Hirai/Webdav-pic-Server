// === モジュール読み込み・共通初期化 ===
// 標準モジュール
const fs = require("fs"); // ファイルシステム操作
const path = require("path"); // パス操作
const http = require("http"); // HTTPサーバー
const sharp = require("sharp"); // 画像変換ライブラリ
const webdav = require("webdav-server").v2; // WebDAVサーバー
const crypto = require("crypto"); // ハッシュ生成
const pLimit = require("p-limit"); // 並列処理制御
const os = require("os"); // OS情報取得（CPU数など）
const stream = require("stream"); // ストリーム処理
const { promisify } = require("util"); // コールバック→Promise変換
const { execFile, spawn } = require("child_process"); // 外部コマンド実行
const zlib = require("zlib"); // 圧縮処理（未使用）
const { LRUCache } = require("lru-cache"); // キャッシュ
function timestamp() {
  return new Date().toISOString();
} // タイムスタンプ

// ロガー
const logger = {
  info: (...args) => console.log(`[${timestamp()}] INFO: ${args.join(" ")}`),
  warn: (...args) => console.log(`[${timestamp()}] WARN: ${args.join(" ")}`),
  error: (...args) => console.error(`[${timestamp()}] ERROR: ${args.join(" ")}`),
  child: () => logger,
  flush: () => {},
};

const MAGICK_CMD = process.env.MAGICK_PATH || "magick"; // ImageMagickのパス

// sharpのパフォーマンス設定
try {
  const cpuCount = Math.max(1, os.cpus().length - 1);
  sharp.concurrency(cpuCount);
  sharp.cache({ memory: 200, files: 100, items: 200 });
  logger.info(`sharp configured: concurrency=${cpuCount}`);
} catch (e) {
  logger.warn("failed to configure sharp performance settings", e);
}

// ストリーム変換用
const PassThrough = stream.PassThrough;
const pipeline = promisify(stream.pipeline);
// 画像キャッシュディレクトリ
const CACHE_DIR = "Y:/caches/webdav/tmp";
// キャッシュ生成の最小画像サイズ（1MB以上のみキャッシュ）
const CACHE_MIN_SIZE = 1 * 1024 * 1024; // 1MB
// キャッシュクリーニング間隔（30分）
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
// キャッシュ有効期間（5分）
const CACHE_TTL_MS = 5 * 60 * 1000;

// キャッシュ全削除関数（同期、起動直後用）
// 指定ディレクトリ配下の全ファイル・サブディレクトリを再帰的に削除
function resetCacheSync(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      resetCacheSync(full); // サブディレクトリも再帰的に削除
      fs.rmdirSync(full, { recursive: true }); // 空になったら削除
    } else {
      fs.unlinkSync(full); // ファイル削除
    }
  }
}

// キャッシュディレクトリ作成＆リセット（初回起動時）
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
logger.info("=== キャッシュリセット中... ===");
resetCacheSync(CACHE_DIR);
logger.info("=== キャッシュリセット完了 ===");

// キャッシュディレクトリ作成・クリーニング
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
async function cleanupCache(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await cleanupCache(full);
      const rem = await fs.promises.readdir(full).catch(() => []);
      if (rem.length === 0) await fs.promises.rmdir(full).catch(() => {});
    } else if (ent.isFile() && full.endsWith(".webp")) {
      const st = await fs.promises.stat(full).catch(() => null);
      if (st && Date.now() - st.mtimeMs > CACHE_TTL_MS) await fs.promises.unlink(full).catch(() => {});
    }
  }
}
setInterval(() => cleanupCache(CACHE_DIR), CLEANUP_INTERVAL_MS);

// ==== サーバー個別設定をここで一括管理 ====
const serverConfigs = [
  {
    PORT: 1900,
    ROOT_PATH: "Z:/",
    MAX_LIST: 128 * 2,
    Photo_Size: 128 * 7,
    defaultQuality: 50,
    label: "軽量版",
  },
  {
    PORT: 1901,
    ROOT_PATH: "Z:/",
    MAX_LIST: 128 * 8,
    Photo_Size: 128 * 8,
    defaultQuality: 70,
    label: "バランス版",
  },
  {
    PORT: 1902,
    ROOT_PATH: "Z:/",
    MAX_LIST: 128 * 32,
    Photo_Size: null, // リサイズなし
    defaultQuality: 85,
    label: "オリジナル版",
  },
];

// ==== メインループで複数サーバーを起動 ====
serverConfigs.forEach((config) => startWebDAV(config));

function startWebDAV(config) {
  const { PORT, ROOT_PATH, MAX_LIST, Photo_Size, defaultQuality, label } = config;
  const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".avif"];
  const DIR_TTL = 60 * 60 * 1000; // 1時間
  const STAT_TTL = 60 * 60 * 1000; // 1時間

  // キャッシュ用LRUキャッシュインスタンス
  // maxはキャッシュエントリ数の上限
  // 古いものから削除される
  // TTLは個別に管理するためここでは指定しない
  // Use LRUCache with ttl to avoid manual time bookkeeping
  const dirCache = new LRUCache({ max: 50000, ttl: DIR_TTL }); // filenames cache
  const statCache = new LRUCache({ max: 200000, ttl: STAT_TTL }); // stat cache
  const limit = pLimit(os.cpus().length);

  // readdirSync/statSync をサーバごとにスコープ化
  const origReaddirSync = fs.readdirSync; // 元のreaddirSyncを保存
  const origStatSync = fs.statSync; // 元のstatSyncを保存
  // Promise版も保存
  const origReaddirP = fs.promises.readdir.bind(fs.promises); // 元のreaddirを保存
  const origStatP = fs.promises.stat.bind(fs.promises); // 元のstatを保存

  // --- readdir(同期)のキャッシュラッパー ---
  function readdirSyncWrap(dir, opts) {
    // optsは{withFileTypes:true}など
    // キャッシュチェック (LRUCache の ttl が有効なら単純に取得)
    const c = dirCache.get(dir);
    if (c) return c.slice(0, MAX_LIST);
    let names = [];
    try {
      const d = fs.opendirSync(dir);
      let ent;
      while ((ent = d.readSync()) !== null && names.length < MAX_LIST) names.push(ent.name);
      d.closeSync();
    } catch {
      names = origReaddirSync(dir, opts).slice(0, MAX_LIST);
    }
    // キャッシュ保存
    try {
      dirCache.set(dir, names);
    } catch (e) {}
    return names;
  }
  // --- statSyncのキャッシュラッパー ---
  function statSyncWrap(p, opts) {
    const c = statCache.get(p);
    if (c) return c;
    try {
      const st = origStatSync(p, opts);
      try {
        statCache.set(p, st);
      } catch (e) {}
      return st;
    } catch {
      return { isFile: () => false, isDirectory: () => false, mtimeMs: 0, size: 0 };
    }
  }
  // --- readdir(非同期)のキャッシュラッパー ---
  async function readdirPWrap(dir, opts) {
    const c = dirCache.get(dir);
    if (c) return c.slice(0, MAX_LIST);
    let names = [];
    try {
      const d = await fs.promises.opendir(dir);
      for await (const ent of d) {
        names.push(ent.name);
        if (names.length >= MAX_LIST) break;
      }
      await d.close();
    } catch {
      names = await origReaddirP(dir, opts);
    }
    try {
      dirCache.set(dir, names);
    } catch (e) {}
    return names;
  }
  // --- stat(非同期)のキャッシュラッパー ---
  async function statPWrap(p, opts) {
    const c = statCache.get(p);
    if (c) return c;
    try {
      const st = await origStatP(p, opts);
      try {
        statCache.set(p, st);
      } catch (e) {}
      return st;
    } catch {
      return { isFile: () => false, isDirectory: () => false, mtimeMs: 0, size: 0 };
    }
  }

  // WebDAVサーバー作成
  const server = new webdav.WebDAVServer({
    requireAuthentification: false,
    autoLoad: { serializers: [] },
  });

  // Depth: infinity のPROPFINDを拒否（無限階層のディレクトリを拒否）
  server.beforeRequest((ctx, next) => {
    if (ctx.request.method === "PROPFIND") {
      const hdr = ctx.request.headers["depth"];
      const depth = (Array.isArray(hdr) ? hdr[0] : hdr) || "1";
      if (depth.toLowerCase() === "infinity") {
        ctx.setCode(403);
        return ctx.response.end("Depth infinity is not supported.");
      }
    }
    next();
  });

  class CachedFileSystem extends webdav.PhysicalFileSystem {
    constructor(rootPath, dirCache, statCache) {
      super(rootPath);
      this.dirCache = dirCache;
      this.statCache = statCache;
    }

    _readdir(path, ctx, callback) {
      try {
        const c = this.dirCache.get(path);
        if (c) return callback(null, c.slice(0, MAX_LIST));
      } catch (e) {
        // fallthrough to super
      }
      super._readdir(path, ctx, (err, names) => {
        if (!err && Array.isArray(names)) {
          try {
            const limited = names.slice(0, MAX_LIST);
            this.dirCache.set(path, limited);
            return callback(null, limited);
          } catch (e) {
            // ignore cache errors
          }
        }
        callback(err, names);
      });
    }

    _stat(path, ctx, callback) {
      try {
        const c = this.statCache.get(path);
        if (c) return callback(null, c);
      } catch (e) {
        // fallthrough to super
      }
      super._stat(path, ctx, (err, stat) => {
        if (!err && stat) {
          try {
            this.statCache.set(path, stat);
          } catch (e) {}
        }
        callback(err, stat);
      });
    }
  }

  // サーバー設定時にインスタンス化
  server.setFileSystem("/", new CachedFileSystem(ROOT_PATH, dirCache, statCache), (success) => {
    if (!success) {
      logger.error(`マウント失敗: ${label}`);
      process.exit(1);
    }

    // HTTPサーバー
    try {
      fs.readdirSync = readdirSyncWrap;
      fs.statSync = statSyncWrap;
      fs.promises.readdir = readdirPWrap;
      fs.promises.stat = statPWrap;
    } catch (e) {
      logger.warn("[warn] failed to install fs wrappers", e);
    }

    // in-flight conversion dedupe map
    const inflight = new Map();
    const INFLIGHT_TIMEOUT_MS = 30 * 1000; // 30秒で先行変換待ちをタイムアウト
    const MAX_INFLIGHT_RETRIES = 1; // 最大リトライ回数（失敗時）
    const RETRY_DELAY_MS = 500; // リトライ間隔
    const FAILED_BACKOFF_MS = 5 * 1000; // 失敗後のバックオフ期間（5秒）
    const failedCache = new LRUCache({ max: 10000, ttl: FAILED_BACKOFF_MS }); // 直近の失敗を記録して直ぐに再試行を避ける

    const safeResolve = (root, urlPath) => {
      const decoded = decodeURIComponent(urlPath || ""); // デコード
      // クエリを削除して先頭のスラッシュを削除
      const rel = decoded.split("?")[0].replace(/^\/+/, "");
      const candidate = path.resolve(root, rel); // 相対パスを解決
      const rootResolved = path.resolve(root); // ルートパスを解決

      // プラットフォームによって異なるパス比較
      if (process.platform === "win32") {
        const lc = candidate.toLowerCase(); // 小文字化
        const rr = rootResolved.toLowerCase(); // 小文字化
        if (!(lc === rr || lc.startsWith(rr + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
      } else {
        if (!(candidate === rootResolved || candidate.startsWith(rootResolved + path.sep))) throw new Error("Access denied"); // パスが一致しない場合はアクセス拒否
      }
      return candidate; // パスを返す
    };

    const httpServer = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0]; // クエリを削除
      // v20 と同様に decodeURIComponent を使って表示用パスを作る
      const displayPath = decodeURIComponent(urlPath); // デコード
      const ext = path.extname(displayPath).toLowerCase(); // 拡張子を小文字化
      let fullPath; // フルパス
      try {
        fullPath = safeResolve(ROOT_PATH, urlPath); // パスを解決
      } catch (e) {
        res.writeHead(403);
        return res.end("Access denied");
      }

      // PROPFINDの場合
      if (req.method === "PROPFIND") {
        let depth = req.headers["depth"]; // 深さ
        if (Array.isArray(depth)) depth = depth[0]; // 配列の場合は最初の要素を取得
        if (depth === undefined) depth = "(none)"; // 深さが未定義の場合は'(none)'
        logger.info(`[PROPFIND] [${label}] from=${req.connection.remoteAddress} path=${displayPath} depth=${depth}`);
      }

      logger.info(`[${label}] ${req.connection.remoteAddress} ${req.method} ${displayPath}`);

      // 画像GETの場合
      if (req.method === "GET" && IMAGE_EXTS.includes(ext)) {
        return limit(async () => {
          logger.info(`[変換要求][${label}] ${fullPath}`);
          const st = await statPWrap(fullPath).catch(() => null); // ファイルの情報を取得
          // ファイルが存在しない場合（ディレクトリやファイルでない場合）
          if (!st || !st.isFile()) {
            logger.warn(`[404 Not Found][${label}] ${fullPath}`);
            res.writeHead(404);
            return res.end("Not found");
          }

          // 画像サイズが1MB以上の場合のみキャッシュ
          const shouldCache = st.size >= CACHE_MIN_SIZE; // キャッシュを使用するかどうか

          // キャッシュkeyにqualityとリサイズ条件も含める
          const qParam = req.url.match(/[?&]q=(\d+)/)?.[1]; // クエリからqualityを取得
          const quality = qParam
            ? Math.min(Math.max(parseInt(qParam, 10), 30), 90) // 30から90の範囲でqualityを取得
            : defaultQuality;

          // ファイルの変更を検知するためにキャッシュkeyにファイルの変更時間とサイズを含める
          const key = crypto
            .createHash("md5")
            .update(fullPath + "|" + (Photo_Size ?? "o") + "|" + quality + "|" + String(st.mtimeMs) + "|" + String(st.size))
            .digest("hex");
          const cachePath = path.join(CACHE_DIR, key + ".webp");

          // キャッシュ利用判定 (非同期でチェックしてブロッキングを避ける)
          if (shouldCache) {
            try {
              const cst = await statPWrap(cachePath).catch(() => null);
              if (cst && cst.isFile && cst.isFile()) {
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
              logger.warn("[cache read error async]", e);
            }
          }

          // recent failure backoff: avoid re-attempting immediately
          if (shouldCache && failedCache.has(key)) {
            logger.warn(`[backoff][${label}] recent failure for key, skipping retry: ${key}`);
            res.writeHead(503);
            return res.end("Temporary conversion failure, try again later");
          }

          // 同じ key で変換中なら待つ（in-flight dedupe）
          if (shouldCache && inflight.has(key)) {
            try {
              await inflight.get(key);
              const cst = await statPWrap(cachePath).catch(() => null);
              if (cst && cst.isFile && cst.isFile()) {
                res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": cst.size });
                return fs.createReadStream(cachePath).pipe(res);
              }
            } catch (e) {
              // 先行変換が失敗したら落ちて次で再生成（待ちがタイムアウト等で失敗）
              logger.warn("[inflight wait error async]", e);
            }
          }

          // perform conversion and optionally cache atomically
          // perform conversion with retry and failure backoff
          const performConversion = async () => {
            let attempt = 0;
            while (true) {
              try {
                await convertAndRespond({ fullPath, displayPath, cachePath: shouldCache ? cachePath : null, quality, Photo_Size, label, fs, sharp, execFile, res });
                return; // success
              } catch (e) {
                attempt++;
                logger.warn(`[inflight convert error][${label}] key=${key} attempt=${attempt} err=${e && e.message ? e.message : e}`);
                if (attempt > MAX_INFLIGHT_RETRIES) {
                  // record failure to avoid rapid re-attempts
                  try {
                    failedCache.set(key, true);
                  } catch (ee) {}
                  throw e;
                }
                // short backoff before retry
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
              }
            }
          };

          const work = performConversion();

          if (shouldCache) {
            // wrap with timeout so waiters don't hang indefinitely
            const timed = Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error("inflight timeout")), INFLIGHT_TIMEOUT_MS))]);
            inflight.set(key, timed);
            timed.then(() => inflight.delete(key)).catch(() => inflight.delete(key));
          }

          return work;
        });
      }

      // WebDAVリクエスト
      try {
        logger.info(`[WebDAV][${label}] ${req.method} ${displayPath}`);
        res.setHeader("Connection", "Keep-Alive");
        res.setHeader("Keep-Alive", "timeout=120");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        server.executeRequest(req, res);
      } catch (e) {
        logger.error("WebDAV error", e);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("WebDAV error");
        } else res.end();
      }
    });

    httpServer.setTimeout(60000);
    httpServer.keepAliveTimeout = 60000;
    httpServer.headersTimeout = 65000;

    // エラーイベントを先に登録しておく（EADDRINUSE などでクラッシュしないように）
    httpServer.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        logger.error(`ポート ${PORT} は既に使用されています。${label} の起動をスキップします。`);
      } else {
        logger.error("HTTP server error", err);
      }
    });

    httpServer.listen(PORT, () => {
      logger.info(`✅ WebDAV [${label}] 起動: http://localhost:${PORT}/`);
      logger.info(`[INFO] キャッシュDir=${CACHE_DIR} / MAX_LIST=${MAX_LIST} / Photo_Size=${Photo_Size ?? "オリジナル"}`);
    });
  });
}

// ======== 画像変換処理を関数化 ========
async function convertAndRespond({ fullPath, displayPath, cachePath, quality, Photo_Size, label, fs, sharp, execFile, res }) {
  // 軽量版判定
  const isFast = label.includes("軽量版");
  // Return a promise so callers can await completion (used by inflight dedupe)
  return new Promise(async (resolve, reject) => {
    const tmpPath = cachePath ? cachePath + `.tmp-${crypto.randomBytes(6).toString("hex")}` : null;
    let transformer;
    try {
      transformer = sharp(fullPath, { limitInputPixels: 1e8 });
      if (!isFast) transformer = transformer.rotate();
      if (Photo_Size) {
        if (isFast) {
          transformer = transformer.resize({ width: Photo_Size, withoutEnlargement: true });
        } else {
          const meta = await transformer.metadata();
          if (meta.width != null && meta.height != null) {
            if (meta.width < meta.height) transformer = transformer.resize({ width: Photo_Size, withoutEnlargement: true });
            else transformer = transformer.resize({ height: Photo_Size, withoutEnlargement: true });
          }
        }
      }
      transformer = transformer.webp({
        quality,
        effort: isFast ? 0 : 1,
        nearLossless: false,
        smartSubsample: isFast ? false : true,
      });

      logger.info(`[変換実行][${label}] ${displayPath} → ${cachePath ?? "(no cache)"} (q=${quality})`);

      const pass = new PassThrough();
      transformer.pipe(pass);

      let wroteHeader = false;

      const onErrorFallback = (err) => {
        logger.warn(`[Sharp失敗→ImageMagick][${label}] ${displayPath} : ${err && err.message ? err.message : err}`);
        // cleanup tmp
        if (tmpPath) fs.unlink(tmpPath, () => {});
        // fallback to magick
        const resizeOpt = Photo_Size ? ["-resize", `${Photo_Size}x${Photo_Size}`] : [];
        const magick = spawn(MAGICK_CMD, [fullPath, ...resizeOpt, "-quality", `${quality}`, "webp:-"]);
        magick.on("error", (err) => {
          logger.error(`[ImageMagick変換失敗][${label}] ${fullPath}: ${err}`);
          if (!res.headersSent) res.writeHead(415);
          res.end("Unsupported image format (sharp+magick error)");
          return reject(err);
        });
        if (!res.headersSent) {
          res.setHeader("Content-Type", "image/webp");
        }
        if (tmpPath) {
          const ws = fs.createWriteStream(tmpPath);
          // write to tmp atomically via pipeline; also stream to response
          pipeline(magick.stdout, ws).catch((e) => logger.error("[magick->tmp pipeline error]", e));
          magick.stdout.pipe(res, { end: false });
          ws.on("finish", () => {
            try {
              fs.renameSync(tmpPath, cachePath);
            } catch (e) {}
          });
        } else {
          pipeline(magick.stdout, res).catch((e) => logger.error("[magick->res pipeline error]", e));
        }
        magick.stdout.on("end", () => {
          logger.info(`[変換完了(fallback)][${label}] ${displayPath}`);
          res.end();
          return resolve();
        });
      };

      transformer.on("error", onErrorFallback);
      pass.on("error", onErrorFallback);

      // If caching, write to tmp then rename. Otherwise stream directly to response.
      if (tmpPath) {
        const ws = fs.createWriteStream(tmpPath);
        let wroteAny = false;
        pass.on("data", (chunk) => {
          if (!wroteHeader) {
            // send headers once we have first chunk size unknown; use chunked transfer
            res.writeHead(200, { "Content-Type": "image/webp", Connection: "Keep-Alive", "Keep-Alive": "timeout=600" });
            wroteHeader = true;
          }
          wroteAny = true;
        });
        // use pipeline for both destinations to ensure proper error handling
        pipeline(pass, ws).catch((e) => logger.error("[cache write pipeline error]", e));
        pipeline(pass, res).catch((e) => logger.error("[response pipeline error]", e));
        pass.on("end", async () => {
          // finalize tmp -> cache (async)
          if (wroteAny) {
            try {
              await fs.promises.rename(tmpPath, cachePath).catch(async (e) => {
                logger.warn("[cache rename error async]", e);
                try {
                  await fs.promises.unlink(tmpPath).catch(() => {});
                } catch (_) {}
              });
            } catch (e) {
              logger.warn("[cache rename outer error]", e);
            }
          } else {
            try {
              await fs.promises.unlink(tmpPath).catch(() => {});
            } catch (_) {}
          }
          logger.info(`[変換完了][${label}] ${displayPath}`);
          res.end();
          return resolve();
        });
      } else {
        // no cache path: stream directly
        pass.once("data", () => {
          if (!wroteHeader) {
            res.writeHead(200, { "Content-Type": "image/webp", Connection: "Keep-Alive", "Keep-Alive": "timeout=600" });
            wroteHeader = true;
          }
        });
        pipeline(pass, res).catch((e) => logger.error("[response pipeline error]", e));
        pass.on("end", () => {
          logger.info(`[変換完了][${label}] ${fullPath}`);
          res.end();
          return resolve();
        });
      }
    } catch (e) {
      // sharp init error -> fallback to magick
      logger.warn("[sharp init error]", e);
      if (tmpPath)
        try {
          fs.promises.unlink(tmpPath).catch(() => {});
        } catch (e) {}
      const resizeOpt = Photo_Size ? ["-resize", `${Photo_Size}x${Photo_Size}`] : [];
      const magick = spawn(MAGICK_CMD, [fullPath, ...resizeOpt, "-quality", `${quality}`, "webp:-"]);
      magick.on("error", (err) => {
        logger.error(`[ImageMagick変換失敗][${label}] ${displayPath}: ${err}`);
        if (!res.headersSent) res.writeHead(415);
        res.end("Unsupported image format (sharp+magick error)");
        return reject(err);
      });
      if (!res.headersSent) res.setHeader("Content-Type", "image/webp");
      if (tmpPath) {
        const ws = fs.createWriteStream(tmpPath);
        pipeline(magick.stdout, ws).catch((e) => logger.error("[magick->tmp pipeline error]", e));
        magick.stdout.pipe(res, { end: false });
        ws.on("finish", async () => {
          try {
            await fs.promises.rename(tmpPath, cachePath).catch(() => {});
          } catch (e) {}
        });
      } else {
        pipeline(magick.stdout, res).catch((e) => logger.error("[magick->res pipeline error]", e));
      }
      magick.stdout.on("end", () => {
        logger.info(`[変換完了(fallback)][${label}] ${displayPath}`);
        res.end();
        return resolve();
      });
    }
  });
}
