const stats = require("../.core/stats");
const fs = require("fs");
const path = require("path");

// モック設定
jest.mock("fs");
jest.mock("path");
jest.mock("../.core/config", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  getImageConversionEnabled: () => true,
  getCompressionEnabled: () => true,
}));

describe("Stats System (統計システム)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // stats.jsonのモック
    fs.readFileSync = jest.fn(() => JSON.stringify({
      since: new Date().toISOString(),
      totals: { requests: 0, savedBytes: 0 },
      categories: { image: {}, text: {} },
    }));
    fs.promises = {
      mkdir: jest.fn(() => Promise.resolve()),
      writeFile: jest.fn(() => Promise.resolve()),
    };
    path.join = jest.fn((...args) => args.join("/"));
    path.dirname = jest.fn((p) => p.split("/").slice(0, -1).join("/"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("recordImageTransfer関数が存在すること", () => {
    expect(typeof stats.recordImageTransfer).toBe("function");
  });

  test("recordTextCompression関数が存在すること", () => {
    expect(typeof stats.recordTextCompression).toBe("function");
  });

  test("getStatsSnapshot関数が存在すること", () => {
    expect(typeof stats.getStatsSnapshot).toBe("function");
  });

  test("画像転送統計を記録できること", () => {
    stats.recordImageTransfer({
      originalBytes: 1000,
      optimizedBytes: 500,
      cacheHit: false,
    });

    // 非同期処理を待機
    jest.advanceTimersByTime(3000);

    const snapshot = stats.getStatsSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.totals).toBeDefined();
  });

  test("テキスト圧縮統計を記録できること", () => {
    stats.recordTextCompression({
      originalBytes: 2000,
      optimizedBytes: 800,
    });

    // 非同期処理を待機
    jest.advanceTimersByTime(3000);

    const snapshot = stats.getStatsSnapshot();
    expect(snapshot).toBeDefined();
  });
});
