const pLimit = require("../.core/p-limit-compat");

describe("p-limit compatibility helper", () => {
  test("指定した並列数を超えて実行しないこと", async () => {
    const limit = pLimit(2);
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, (_, index) =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return index;
      })
    );

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("不正な並列数を拒否すること", () => {
    expect(() => pLimit(0)).toThrow(TypeError);
    expect(() => pLimit(1.5)).toThrow(TypeError);
  });
});
