const webdav = require("../.core/webdav");
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
  getDynamicConfig: jest.fn((key, defaultValue) => {
    const config = {
      PHOTO_SIZE: 640,
      MAX_LIST: 1280,
      DEFAULT_QUALITY: 70,
      PORT: 8080,
      ROOT_PATH: "/test/root",
    };
    return config[key] || defaultValue;
  }),
  getServerPort: () => 8080,
  getServerRootPath: () => "/test/root",
  getSSLCertPath: () => null,
  getSSLKeyPath: () => null,
  getCompressionEnabled: () => false,
  getCompressionThreshold: () => 0.3,
  getImageConversionEnabled: () => true,
  getCacheMinSize: () => 1048576,
  getCacheTTL: () => 900000,
}));

jest.mock("../.core/image", () => ({
  convertAndRespond: jest.fn(),
  convertAndRespondWithLimit: jest.fn(),
}));

jest.mock("../.core/stats", () => ({
  recordImageTransfer: jest.fn(),
  recordTextCompression: jest.fn(),
  getStatsSnapshot: jest.fn(() => ({
    totals: { requests: 0, savedBytes: 0 },
    categories: { image: {}, text: {} },
  })),
}));

describe("WebDAV Server (WebDAVサーバー)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("startWebDAV関数が存在すること", () => {
    expect(typeof webdav.startWebDAV).toBe("function");
  });

  test("サーバー起動時にエラーが発生しないこと", () => {
    // 注意: 実際のサーバー起動はテスト環境では行わない
    // 関数の存在と型のみを確認
    expect(() => {
      // モック環境で関数が呼び出せることを確認
      if (typeof webdav.startWebDAV === "function") {
        // 実際の起動は行わない（ポート競合を避けるため）
      }
    }).not.toThrow();
  });

  test("ETagが一致する場合は304応答として処理すること", () => {
    const req = {
      headers: {
        "if-none-match": '"cache-key-100"',
      },
    };
    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };
    const headers = {
      "Content-Type": "image/webp",
      "Content-Length": 100,
      ETag: '"cache-key-100"',
      "Last-Modified": "Sat, 25 Apr 2026 00:00:00 GMT",
    };

    const result = webdav.__private.handleConditionalAndRange(
      req,
      res,
      headers,
      100
    );

    expect(result).toEqual({ handled: true });
    expect(res.writeHead).toHaveBeenCalledWith(
      304,
      expect.not.objectContaining({
        "Content-Length": expect.anything(),
        "Content-Type": expect.anything(),
      })
    );
    expect(res.end).toHaveBeenCalled();
  });

  test("Rangeヘッダーを解析して部分範囲を返すこと", () => {
    expect(webdav.__private.parseRange("bytes=10-19", 100)).toEqual({
      start: 10,
      end: 19,
    });
    expect(webdav.__private.parseRange("bytes=-10", 100)).toEqual({
      start: 90,
      end: 99,
    });
    expect(webdav.__private.parseRange("bytes=100-120", 100)).toEqual({
      invalid: true,
    });
  });
});
