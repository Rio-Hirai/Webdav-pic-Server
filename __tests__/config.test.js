const config = require("../.core/config");

// ロガーのモック
config.logger.warn = jest.fn();
config.logger.info = jest.fn();

describe("Config Validation (設定検証)", () => {
  const { getDynamicConfig } = config;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {}; // 環境変数をクリア
  });

  afterAll(() => {
    if (config.stopConfigMonitoring) {
      config.stopConfigMonitoring();
    }
  });

  test("環境変数が未定義の場合、デフォルト値を返すこと", () => {
    const val = getDynamicConfig("SOME_KEY", "default");
    expect(val).toBe("default");
  });

  test("数値を検証すること", () => {
    process.env.MAX_CONCURRENCY = "10";
    expect(getDynamicConfig("MAX_CONCURRENCY", 4)).toBe(10);

    process.env.MAX_CONCURRENCY = "abc";
    expect(getDynamicConfig("MAX_CONCURRENCY", 4)).toBe(4); // デフォルト値にフォールバック
    expect(config.logger.warn).toHaveBeenCalled();
  });

  test("数値の範囲を検証すること", () => {
    // MAX_CONCURRENCY の範囲は 1-32
    process.env.MAX_CONCURRENCY = "100";
    expect(getDynamicConfig("MAX_CONCURRENCY", 4)).toBe(4); // フォールバック

    process.env.MAX_CONCURRENCY = "0";
    expect(getDynamicConfig("MAX_CONCURRENCY", 4)).toBe(4); // フォールバック
  });

  test("真偽値を検証すること", () => {
    process.env.COMPRESSION_ENABLED = "true";
    expect(getDynamicConfig("COMPRESSION_ENABLED", false)).toBe(true);

    process.env.COMPRESSION_ENABLED = "false";
    expect(getDynamicConfig("COMPRESSION_ENABLED", true)).toBe(false);

    process.env.COMPRESSION_ENABLED = "invalid";
    expect(getDynamicConfig("COMPRESSION_ENABLED", true)).toBe(true); // フォールバック
  });

  test("浮動小数点値を検証すること", () => {
    process.env.COMPRESSION_THRESHOLD = "0.5";
    expect(getDynamicConfig("COMPRESSION_THRESHOLD", 0.1)).toBe(0.5);

    process.env.COMPRESSION_THRESHOLD = "1.5"; // > 1.0
    expect(getDynamicConfig("COMPRESSION_THRESHOLD", 0.1)).toBe(0.1); // フォールバック
  });
});
