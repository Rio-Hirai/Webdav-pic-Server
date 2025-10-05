// === スタック処理システムモジュール ===
const { logger } = require("./config");

/**
 * リクエストスタッククラス
 * 適応的処理方式：30件以下はFIFO（先入先出し）、30件超はLIFO（後入先出し）
 * 少量リクエスト時は順序を保ち、大量リクエスト時はユーザビリティを優先
 */
class RequestStack {
  constructor() {
    this.stack = []; // リクエストスタック
    this.processing = false; // 処理中フラグ
    this.maxStackSize = 100; // スタックの最大サイズ
    this.processedCount = 0; // 処理済みリクエスト数
    this.lastProcessTime = Date.now(); // 最後の処理時刻
    this.stuckCheckInterval = null; // スタック監視のインターバル
    this.currentFolder = null; // 現在のフォルダパス
    this.folderChangeCount = 0; // フォルダ変更回数

    // スタック監視を開始（5秒間隔でチェック）
    this.startStuckMonitoring();
  }

  // リクエストをスタックに追加
  push(requestInfo) {
    // フォルダ変更検出
    const requestFolder = this.extractFolderFromPath(requestInfo.displayPath);
    if (this.currentFolder !== null && this.currentFolder !== requestFolder) {
      // フォルダが変更された場合はスタックをクリア
      this.clearStackForFolderChange(requestFolder);
    }
    this.currentFolder = requestFolder;

    // 積極的なスタックサイズ制限（50個で警告、80個で積極的破棄）
    if (this.stack.length >= 80) {
      // 80個以上の場合、古いリクエストを50%破棄
      const removeCount = Math.floor(this.stack.length * 0.5);
      for (let i = 0; i < removeCount; i++) {
        const removed = this.stack.shift();
        if (removed && removed.res && !removed.res.headersSent) {
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          removed.res.end('Request stack overflow. Please retry.');
        }
      }
      logger.warn(`[スタック積極的破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`);
    } else if (this.stack.length >= 50) {
      // 50個以上の場合、古いリクエストを25%破棄
      const removeCount = Math.floor(this.stack.length * 0.25);
      for (let i = 0; i < removeCount; i++) {
        const removed = this.stack.shift();
        if (removed && removed.res && !removed.res.headersSent) {
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          removed.res.end('Request stack overflow. Please retry.');
        }
      }
      logger.warn(`[スタック部分破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`);
    } else if (this.stack.length >= this.maxStackSize) {
      // 最大サイズの場合、古いリクエストを1件削除
      const removed = this.stack.shift();
      if (removed && removed.res && !removed.res.headersSent) {
        removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        removed.res.end('Request stack overflow. Please retry.');
      }
      logger.warn(`[スタックオーバーフロー] 古いリクエストを破棄: ${removed?.displayPath || 'unknown'}`);
    }

    // 新しいリクエストをスタックの最後に追加（LIFOのため最後が最優先）
    this.stack.push(requestInfo);
    logger.info(`[スタック追加] ${requestInfo.displayPath} (スタックサイズ: ${this.stack.length})`);

    // 処理を開始
    this.processNext();
  }

  // 次のリクエストを処理
  async processNext() {
    if (this.processing || this.stack.length === 0) {
      return; // 既に処理中またはスタックが空の場合は何もしない
    }

    this.processing = true;

    // 適応的処理方式：30件以下はFIFO、30件超はLIFO
    let requestInfo;
    if (this.stack.length <= 30) {
      // FIFO（先入先出し）：最初のリクエストを取得
      requestInfo = this.stack.shift();
    } else {
      // LIFO（後入先出し）：最新のリクエストを取得
      requestInfo = this.stack.pop();
    }

    // タイムアウト設定（8秒でタイムアウト）
    const timeoutId = setTimeout(() => {
      logger.warn(`[スタック処理タイムアウト] ${requestInfo.displayPath} - 8秒でタイムアウト`);
      if (requestInfo.res && !requestInfo.res.headersSent) {
        requestInfo.res.writeHead(408, { 'Content-Type': 'text/plain; charset=utf-8' });
        requestInfo.res.end('Request timeout');
      }
      this.processing = false;
      // 次のリクエストを処理
      setTimeout(() => this.processNext(), 5);
    }, 8000);

    try {
      const processingMode = this.stack.length <= 30 ? 'FIFO' : 'LIFO';
      logger.info(`[スタック処理開始][${processingMode}] ${requestInfo.displayPath} (残り: ${this.stack.length})`);

      // 最後の処理時刻を更新
      this.lastProcessTime = Date.now();

      // リクエスト処理を実行（タイムアウト付き）
      await Promise.race([
        requestInfo.processor(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Processor timeout')), 6000))
      ]);

      clearTimeout(timeoutId);
      this.processedCount++;
      this.lastProcessTime = Date.now(); // 完了時刻も更新
      logger.info(`[スタック処理完了] ${requestInfo.displayPath} (処理済み: ${this.processedCount})`);

    } catch (error) {
      clearTimeout(timeoutId);
      logger.error(`[スタック処理エラー] ${requestInfo.displayPath}: ${error.message}`);

      // エラー時は適切なレスポンスを送信
      if (requestInfo.res && !requestInfo.res.headersSent) {
        requestInfo.res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        requestInfo.res.end('Internal server error');
      }
    } finally {
      this.processing = false;

      // スタックに残りのリクエストがあれば次の処理を開始
      if (this.stack.length > 0) {
        // 次の処理を少し遅延させてCPU負荷を軽減
        setTimeout(() => this.processNext(), 5);
      }
    }
  }

  // スタック監視を開始
  startStuckMonitoring() {
    this.stuckCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastProcess = now - this.lastProcessTime;

      // 処理中で5秒以上経過している場合は強制復旧（より積極的）
      if (this.processing && timeSinceLastProcess > 5000) {
        logger.warn(`[スタック強制復旧] 処理が5秒以上停止しています - 強制復旧を実行`);
        this.forceRecovery();
      }

      // スタックが30個以上溜まっている場合は警告
      if (this.stack.length > 30) {
        logger.warn(`[スタック警告] スタックが${this.stack.length}個に達しています`);
      }

      // スタックが60個以上溜まっている場合は積極的破棄
      if (this.stack.length > 60) {
        const removeCount = Math.floor(this.stack.length * 0.3); // 30%破棄
        for (let i = 0; i < removeCount; i++) {
          const removed = this.stack.shift();
          if (removed && removed.res && !removed.res.headersSent) {
            removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            removed.res.end('Request stack emergency clear. Please retry.');
          }
        }
        logger.warn(`[スタック緊急破棄] ${removeCount}件のリクエストを破棄 (残り: ${this.stack.length})`);
        this.forceRecovery();
      }

      // スタックが100個以上溜まっている場合は強制復旧
      if (this.stack.length > 100) {
        logger.warn(`[スタック緊急復旧] スタックが${this.stack.length}個に達しています - 緊急復旧を実行`);
        this.forceRecovery();
      }
    }, 3000); // 3秒間隔でチェック（より頻繁に監視）
  }

  // 強制復旧処理
  forceRecovery() {
    logger.error(`[スタック強制復旧実行] 処理中フラグをリセット`);
    this.processing = false;
    this.lastProcessTime = Date.now();

    // 次のリクエストを処理
    setTimeout(() => this.processNext(), 100);
  }

  // スタックの状態を取得
  getStatus() {
    return {
      stackSize: this.stack.length,
      processing: this.processing,
      processedCount: this.processedCount,
      maxStackSize: this.maxStackSize,
      timeSinceLastProcess: Date.now() - this.lastProcessTime,
      currentFolder: this.currentFolder,
      folderChangeCount: this.folderChangeCount
    };
  }

  // パスからフォルダを抽出
  extractFolderFromPath(displayPath) {
    // パスからフォルダ部分を抽出
    const pathParts = displayPath.split('/');
    if (pathParts.length <= 2) {
      return displayPath; // ルートレベルの場合
    }
    // 最後の要素（ファイル名）を除いた部分をフォルダパスとする
    return pathParts.slice(0, -1).join('/');
  }

  // フォルダ変更時のスタッククリア
  clearStackForFolderChange(newFolder) {
    this.folderChangeCount++;
    const clearedCount = this.stack.length;

    // スタック内のすべてのリクエストにエラーレスポンスを送信
    this.stack.forEach(requestInfo => {
      if (requestInfo.res && !requestInfo.res.headersSent) {
        requestInfo.res.writeHead(410, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        requestInfo.res.end('Request cancelled due to folder change');
      }
    });

    // スタックをクリア
    this.stack = [];

    // 処理中フラグをリセット
    this.processing = false;

    logger.info(`[フォルダ変更検出] "${this.currentFolder}" → "${newFolder}" - ${clearedCount}件のリクエストを破棄 (変更回数: ${this.folderChangeCount})`);
  }

  // スタック監視を停止
  stopMonitoring() {
    if (this.stuckCheckInterval) {
      clearInterval(this.stuckCheckInterval);
      this.stuckCheckInterval = null;
    }
  }
}

/**
 * シンプルなサーバー監視クラス
 * スタック処理システム用の軽量な監視機能
 */
class SimpleServerMonitor {
  constructor(requestStack) {
    this.requestStack = requestStack;
    this.requestCount = 0;
    this.lastLogTime = Date.now();
  }

  // リクエスト開始（スタック処理では単純にカウントのみ）
  startRequest() {
    this.requestCount++;
    return `request-${this.requestCount}`;
  }

  // リクエスト終了（スタック処理では単純にカウントのみ）
  endRequest() {
      // 定期的にスタック状況をログ
      const now = Date.now();
      if (now - this.lastLogTime > 30000) { // 30秒ごと
        const stackStatus = this.requestStack.getStatus();
        const processingMode = stackStatus.stackSize <= 30 ? 'FIFO' : 'LIFO';
        logger.info(`[サーバー状況] 総リクエスト: ${this.requestCount}, スタック: ${stackStatus.stackSize}/${stackStatus.maxStackSize} (${processingMode}), 処理中: ${stackStatus.processing}, フォルダ: ${stackStatus.currentFolder || 'none'}, 変更回数: ${stackStatus.folderChangeCount}`);
        this.lastLogTime = now;
      }
  }

  // 負荷状況取得
  getLoadStatus() {
    const stackStatus = this.requestStack.getStatus();
    return {
      totalRequests: this.requestCount,
      stackSize: stackStatus.stackSize,
      processing: stackStatus.processing,
      processedCount: stackStatus.processedCount
    };
  }
}

/**
 * スタック処理システムの初期化
 * @returns {Object} 初期化されたスタック処理システムのオブジェクト
 */
function initializeStackSystem() {
  const requestStack = new RequestStack();
  const serverMonitor = new SimpleServerMonitor(requestStack);

  return {
    requestStack,
    serverMonitor
  };
}

module.exports = {
  RequestStack,
  SimpleServerMonitor,
  initializeStackSystem
};
