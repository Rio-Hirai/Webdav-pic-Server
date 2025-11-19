const { RequestStack, SimpleServerMonitor } = require("../.core/stack");
const { logger, stopConfigMonitoring } = require("../.core/config");

// テスト中のコンソール出力を抑制するためのロガーモック
logger.info = jest.fn();
logger.warn = jest.fn();
logger.error = jest.fn();

describe("RequestStack (リクエストスタック)", () => {
  let requestStack;
  let mockRes;

  beforeEach(() => {
    jest.useFakeTimers();
    requestStack = new RequestStack();
    requestStack.stopMonitoring(); // オープンハンドルを防ぐために内部インターバルを停止
    mockRes = {
      writeHead: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterAll(() => {
    stopConfigMonitoring();
  });

  test("スタックサイズが小さい場合、リクエストをFIFO（先入れ先出し）順で処理すること", async () => {
    const executionOrder = [];

    // 3つのリクエストを追加
    requestStack.push({
      displayPath: "/req1",
      res: { ...mockRes },
      processor: async () => {
        executionOrder.push(1);
      },
    });
    requestStack.push({
      displayPath: "/req2",
      res: { ...mockRes },
      processor: async () => {
        executionOrder.push(2);
      },
    });
    requestStack.push({
      displayPath: "/req3",
      res: { ...mockRes },
      processor: async () => {
        executionOrder.push(3);
      },
    });

    // 処理を待機
    await jest.runAllTimersAsync();

    expect(executionOrder).toEqual([1, 2, 3]);
  });

  test("スタックサイズが大きい場合（>30）、リクエストをLIFO（後入れ先出し）順で処理すること", async () => {
    const executionOrder = [];

    // 負荷 > 30 をシミュレートするためにスタックを手動で埋める
    // 状態セットアップのために内部スタック配列に直接アクセス
    requestStack.stack = [];
    for (let i = 0; i < 35; i++) {
      requestStack.stack.push({
        displayPath: `/dummy${i}`,
        res: { ...mockRes },
        processor: async () => {
          executionOrder.push(i);
        },
      });
    }

    // processNextが実行されるようにprocessingをfalseにする
    requestStack.processing = false;

    // LIFOモードでは processNext は最後のアイテム（インデックス34）を選択するはず
    await requestStack.processNext();

    expect(executionOrder[0]).toBe(34);
  });

  test("フォルダ変更時にスタックをクリアすること", () => {
    // 1. フォルダ1のリクエストを追加
    requestStack.push({
      displayPath: "/folder1/img1.jpg",
      res: { ...mockRes },
      processor: async () => {},
    });

    // 2. フォルダ1の別のリクエストを追加
    requestStack.push({
      displayPath: "/folder1/img2.jpg",
      res: { ...mockRes },
      processor: async () => {},
    });

    expect(requestStack.stack.length).toBeGreaterThan(0);

    // 3. フォルダ2のリクエストを追加（クリアがトリガーされるはず）
    const resFolder2 = { ...mockRes };
    requestStack.push({
      displayPath: "/folder2/img1.jpg",
      res: resFolder2,
      processor: async () => {},
    });

    // スタックには新しいリクエストのみが含まれる（または即座に処理された場合は空になる）はず
    // しかし重要なのは、スタック内の以前のリクエストがキャンセルされたこと
    // キャンセルされたアイテムの状態を確認するのは難しいため、ログまたはスタックサイズのリセットに依存する

    // pushはprocessNextを呼び出すため、新しいアイテムはポップされる可能性がある
    // clearStackForFolderChangeロジックが実行されたかを確認する
    // clearStackForFolderChangeをスパイする

    const spy = jest.spyOn(requestStack, "clearStackForFolderChange");

    // リセットして再試行
    requestStack.stack = [];
    requestStack.currentFolder = "/folder1";

    requestStack.push({
      displayPath: "/folder2/img1.jpg",
      res: { ...mockRes },
      processor: async () => {},
    });

    expect(spy).toHaveBeenCalled();
  });
});
