const { CachedFileSystemWrapper } = require("../.core/fs-wrapper");
const { LRUCache } = require("lru-cache");
const fs = require("fs");

// モック設定
jest.mock("fs");
jest.mock("../.core/config", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("CachedFileSystemWrapper (ファイルシステムラッパー)", () => {
  let wrapper;
  let dirCache;
  let statCache;
  let getMaxList;

  beforeEach(() => {
    jest.clearAllMocks();
    
    dirCache = new LRUCache({ max: 100, ttl: 1000 });
    statCache = new LRUCache({ max: 100, ttl: 1000 });
    getMaxList = jest.fn(() => 100);

    wrapper = new CachedFileSystemWrapper(dirCache, statCache, getMaxList);

    // fsモックの設定
    fs.opendirSync = jest.fn(() => ({
      readSync: jest.fn(() => null),
      closeSync: jest.fn(),
    }));
    fs.readdirSync = jest.fn(() => ["file1.txt", "file2.txt"]);
    fs.statSync = jest.fn(() => ({
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: Date.now(),
      size: 1024,
    }));
    fs.promises = {
      opendir: jest.fn(() => Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { name: "file1.txt" };
          yield { name: "file2.txt" };
        },
        close: jest.fn(() => Promise.resolve()),
      })),
      readdir: jest.fn(() => Promise.resolve(["file1.txt", "file2.txt"])),
      stat: jest.fn(() => Promise.resolve({
        isFile: () => true,
        isDirectory: () => false,
        mtimeMs: Date.now(),
        size: 1024,
      })),
    };
  });

  test("CachedFileSystemWrapperクラスが存在すること", () => {
    expect(CachedFileSystemWrapper).toBeDefined();
  });

  test("readdirSyncがキャッシュから値を返すこと", () => {
    dirCache.set("/test", ["cached1.txt", "cached2.txt"]);

    const result = wrapper.readdirSync("/test");

    expect(result).toEqual(["cached1.txt", "cached2.txt"]);
    expect(fs.opendirSync).not.toHaveBeenCalled();
  });

  test("readdirSyncがキャッシュミス時にファイルシステムから読み込むこと", () => {
    const mockDirHandle = {
      readSync: jest.fn()
        .mockReturnValueOnce({ name: "file1.txt" })
        .mockReturnValueOnce({ name: "file2.txt" })
        .mockReturnValue(null),
      closeSync: jest.fn(),
    };
    fs.opendirSync.mockReturnValue(mockDirHandle);

    const result = wrapper.readdirSync("/test");

    expect(fs.opendirSync).toHaveBeenCalledWith("/test");
    expect(result).toContain("file1.txt");
    expect(result).toContain("file2.txt");
  });

  test("statSyncがキャッシュから値を返すこと", () => {
    const cachedStat = {
      isFile: () => true,
      isDirectory: () => false,
      mtimeMs: 1234567890,
      size: 2048,
    };
    statCache.set("/test/file.txt", cachedStat);

    const result = wrapper.statSync("/test/file.txt");

    expect(result).toBe(cachedStat);
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  test("statSyncがキャッシュミス時にファイルシステムから読み込むこと", () => {
    const result = wrapper.statSync("/test/file.txt");

    expect(fs.statSync).toHaveBeenCalledWith("/test/file.txt", undefined);
    expect(result).toBeDefined();
  });

  test("readdirが非同期で動作すること", async () => {
    const result = await wrapper.readdir("/test");

    expect(fs.promises.opendir).toHaveBeenCalledWith("/test");
    expect(result).toBeDefined();
  });

  test("statが非同期で動作すること", async () => {
    const result = await wrapper.stat("/test/file.txt");

    expect(fs.promises.stat).toHaveBeenCalledWith("/test/file.txt", undefined);
    expect(result).toBeDefined();
  });
});
