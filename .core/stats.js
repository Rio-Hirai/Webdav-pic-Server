// === 統計集計モジュール ===
// 画像変換/テキスト圧縮の削減量を非同期に集計し、設定UIから参照できるようにする。
const fs = require("fs");
const path = require("path");
const { logger, getImageConversionEnabled, getCompressionEnabled } = require("./config");

const STATS_FILE = path.join(__dirname, "..", "logs", "stats.json");
const WRITE_DEBOUNCE_MS = 2000;

/**
 * @returns {object} カテゴリごとの初期値
 */
function createCategoryDefaults() {
  return {
    requests: 0,
    optimizedResponses: 0,
    cacheHits: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    savedBytes: 0,
    maxSavedBytes: 0,
  };
}

/**
 * @returns {object} 集計全体の初期状態
 */
function createInitialAggregate() {
  return {
    since: new Date().toISOString(),
    lastUpdated: null,
    totals: {
      requests: 0,
      originalBytes: 0,
      optimizedBytes: 0,
      savedBytes: 0,
      maxSavedBytes: 0,
    },
    categories: {
      image: { ...createCategoryDefaults(), name: "image" },
      text: { ...createCategoryDefaults(), name: "text" },
    },
  };
}

let aggregate = loadAggregateFromDisk();
const pendingEntries = [];
let flushScheduled = false;
let pendingWriteTimer = null;

/**
 * 保存済みの統計ファイルを読み込んで復元する。
 */
function loadAggregateFromDisk() {
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const base = createInitialAggregate();
    return mergeAggregate(base, parsed);
  } catch (_) {
    return createInitialAggregate();
  }
}

/**
 * 既存データに新しいキーをマージする（将来の拡張に備えたフォールバック）。
 */
function mergeAggregate(base, incoming) {
  try {
    if (incoming && typeof incoming === "object") {
      if (incoming.since) base.since = incoming.since;
      if (incoming.lastUpdated) base.lastUpdated = incoming.lastUpdated;

      ["requests", "originalBytes", "optimizedBytes", "savedBytes", "maxSavedBytes"].forEach(
        (key) => {
          if (typeof incoming.totals?.[key] === "number") {
            base.totals[key] = incoming.totals[key];
          }
        },
      );

      for (const [name, data] of Object.entries(incoming.categories || {})) {
        const bucket = base.categories[name] || { ...createCategoryDefaults(), name };
        ["requests", "optimizedResponses", "cacheHits", "originalBytes", "optimizedBytes", "savedBytes", "maxSavedBytes"].forEach(
          (key) => {
            if (typeof data[key] === "number") bucket[key] = data[key];
          },
        );
        base.categories[name] = bucket;
      }
    }
  } catch (err) {
    logger.warn("[stats merge error]", err && err.message ? err.message : err);
  }
  return base;
}

/**
 * 値を非負の数値に正規化する。
 */
function sanitizeBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

/**
 * キューに追加して非同期フラッシュをスケジューリングする。
 */
function enqueue(entry) {
  pendingEntries.push(entry);
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(flushQueue);
  }
}

/**
 * キュー内のエントリを反映する。
 */
function flushQueue() {
  flushScheduled = false;
  while (pendingEntries.length) {
    const entry = pendingEntries.shift();
    applyEntry(entry);
  }
  schedulePersist();
}

/**
 * 単一エントリを集計に反映する。
 */
function applyEntry(entry) {
  if (!entry || typeof entry.category !== "string") return;
  const originalBytes = sanitizeBytes(entry.originalBytes);
  const optimizedBytes = sanitizeBytes(entry.optimizedBytes);
  const savedBytes = Math.max(0, originalBytes - optimizedBytes);

  const bucket = getCategoryBucket(entry.category);
  bucket.requests += 1;
  bucket.originalBytes += originalBytes;
  bucket.optimizedBytes += optimizedBytes;
  bucket.savedBytes += savedBytes;
  if (savedBytes > 0) bucket.optimizedResponses += 1;
  if (entry.cacheHit) bucket.cacheHits += 1;
  if (savedBytes > bucket.maxSavedBytes) bucket.maxSavedBytes = savedBytes;

  aggregate.totals.requests += 1;
  aggregate.totals.originalBytes += originalBytes;
  aggregate.totals.optimizedBytes += optimizedBytes;
  aggregate.totals.savedBytes += savedBytes;
  if (savedBytes > aggregate.totals.maxSavedBytes) {
    aggregate.totals.maxSavedBytes = savedBytes;
  }

  aggregate.lastUpdated = new Date().toISOString();
}

/**
 * カテゴリバケットを取得（存在しない場合は生成）する。
 */
function getCategoryBucket(name) {
  if (!aggregate.categories[name]) {
    aggregate.categories[name] = { ...createCategoryDefaults(), name };
  }
  return aggregate.categories[name];
}

/**
 * ディスクへの遅延書き込みを設定。
 */
function schedulePersist() {
  if (pendingWriteTimer) return;
  pendingWriteTimer = setTimeout(persistToDisk, WRITE_DEBOUNCE_MS);
}

/**
 * 現在の集計情報をファイルに保存する。
 */
async function persistToDisk() {
  pendingWriteTimer = null;
  try {
    await fs.promises.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fs.promises.writeFile(STATS_FILE, JSON.stringify(aggregate, null, 2), "utf8");
  } catch (err) {
    logger.warn("[stats persist error]", err && err.message ? err.message : err);
  }
}

/**
 * 集計スナップショットを返す。
 */
function getStatsSnapshot() {
  const clone = JSON.parse(JSON.stringify(aggregate));
  clone.totals.reductionRatio = computeReductionRatio(
    clone.totals.originalBytes,
    clone.totals.optimizedBytes,
  );
  for (const bucket of Object.values(clone.categories)) {
    bucket.reductionRatio = computeReductionRatio(bucket.originalBytes, bucket.optimizedBytes);
  }
  return clone;
}

function computeReductionRatio(original, optimized) {
  if (!original) return 0;
  return (original - optimized) / original;
}

/**
 * 画像変換の転送結果を記録する。
 */
function recordImageTransfer({ originalBytes, optimizedBytes, cacheHit }) {
  if (!getImageConversionEnabled()) return;
  enqueue({
    category: "image",
    originalBytes,
    optimizedBytes,
    cacheHit: Boolean(cacheHit),
  });
}

/**
 * テキスト/gzip圧縮の転送結果を記録する。
 */
function recordTextCompression({ originalBytes, optimizedBytes }) {
  if (!getCompressionEnabled()) return;
  enqueue({
    category: "text",
    originalBytes,
    optimizedBytes,
    cacheHit: false,
  });
}

module.exports = {
  recordImageTransfer,
  recordTextCompression,
  getStatsSnapshot,
};

