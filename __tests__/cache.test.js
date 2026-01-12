const cache = require("../.core/cache");
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
  getCacheMinSize: () => 1048576,
  getCacheTTL: () => 900000,
}));

describe("Cache System (キャッシュシステム)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync = jest.fn(() => false);
    fs.mkdirSync = jest.fn();
    fs.writeFileSync = jest.fn();
    fs.unlinkSync = jest.fn();
    fs.readdirSync = jest.fn(() => []);
    fs.promises = {
      readdir: jest.fn(() => Promise.resolve([])),
      stat: jest.fn(() => Promise.resolve({ mtimeMs: Date.now(), isFile: () => true })),
      unlink: jest.fn(() => Promise.resolve()),
      rmdir: jest.fn(() => Promise.resolve()),
    };
  });

  test("initializeCacheSystem関数が存在すること", () => {
    expect(typeof cache.initializeCacheSystem).toBe("function");
  });

  test("キャッシュディレクトリが存在しない場合、作成されること", () => {
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.unlinkSync.mockReturnValue(undefined);

    const result = cache.initializeCacheSystem();
    
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled(); // 権限テスト
    expect(fs.unlinkSync).toHaveBeenCalled(); // 権限テストファイル削除
  });

  test("resetCacheSync関数が存在すること", () => {
    expect(typeof cache.resetCacheSync).toBe("function");
  });

  test("cleanupCache関数が存在すること", () => {
    expect(typeof cache.cleanupCache).toBe("function");
  });
});
