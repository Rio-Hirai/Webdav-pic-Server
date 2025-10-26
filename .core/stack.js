// === スタック処理システムモジュール ===
const { logger } = require("./config"); // 設定管理モジュール

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
    this.currentFolder = requestFolder; // 現在のフォルダパスを更新

    // 積極的なスタックサイズ制限（50個で警告、80個で積極的破棄）
    if (this.stack.length >= 80) { // 80個以上の場合
      // 80個以上の場合、古いリクエストを50%破棄
      const removeCount = Math.floor(this.stack.length * 0.5);
      for (let i = 0; i < removeCount; i++) { // 50%破棄
        const removed = this.stack.shift();
        if (removed && removed.res && !removed.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          removed.res.end('Request stack overflow. Please retry.'); // リクエストスタックオーバーフローの場合は503エラーを返す
        }
      }
      logger.warn(`[スタック積極的破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`); // ログを出力
    } else if (this.stack.length >= 50) { // 50個以上の場合
      // 50個以上の場合、古いリクエストを25%破棄
      const removeCount = Math.floor(this.stack.length * 0.25); // 25%破棄
      for (let i = 0; i < removeCount; i++) {
        const removed = this.stack.shift(); // 古いリクエストを削除
        if (removed && removed.res && !removed.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
          removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); // 503エラーを返す
          removed.res.end('Request stack overflow. Please retry.'); // リクエストスタックオーバーフローの場合は503エラーを返す
        }
      }
      logger.warn(`[スタック部分破棄] ${removeCount}件の古いリクエストを破棄 (残り: ${this.stack.length})`); // ログを出力
    } else if (this.stack.length >= this.maxStackSize) {
      // 最大サイズの場合、古いリクエストを1件削除
      const removed = this.stack.shift(); // 古いリクエストを削除
      if (removed && removed.res && !removed.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
        removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); // 503エラーを返す
        removed.res.end('Request stack overflow. Please retry.'); // リクエストスタックオーバーフローの場合は503エラーを返す
      }
      logger.warn(`[スタックオーバーフロー] 古いリクエストを破棄: ${removed?.displayPath || 'unknown'}`); // ログを出力
    }

    // 新しいリクエストをスタックの最後に追加（LIFOのため最後が最優先）
    this.stack.push(requestInfo); // 新しいリクエストをスタックの最後に追加
    logger.info(`[スタック追加] ${requestInfo.displayPath} (スタックサイズ: ${this.stack.length})`); // ログを出力

    // 処理を開始
    this.processNext(); // 次のリクエストを処理
  }

  // 次のリクエストを処理
  async processNext() {
    if (this.processing || this.stack.length === 0) { // 既に処理中またはスタックが空の場合
      return; // 既に処理中またはスタックが空の場合は何もしない
    }

    this.processing = true; // 処理中フラグをセット

    // 適応的処理方式：30件以下はFIFO、30件超はLIFO
    let requestInfo;
    if (this.stack.length <= 30) { // 30件以下の場合
      // FIFO（先入先出し）：最初のリクエストを取得
      requestInfo = this.stack.shift();
    } else { // 30件超の場合
      // LIFO（後入先出し）：最新のリクエストを取得
      requestInfo = this.stack.pop(); // 最新のリクエストを取得
    }

    // タイムアウト設定（8秒でタイムアウト）
    const timeoutId = setTimeout(() => { // 8秒でタイムアウト
      logger.warn(`[スタック処理タイムアウト] ${requestInfo.displayPath} - 8秒でタイムアウト`); // ログを出力
      if (requestInfo.res && !requestInfo.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
        requestInfo.res.writeHead(408, { 'Content-Type': 'text/plain; charset=utf-8' }); // 408エラーを返す
        requestInfo.res.end('Request timeout'); // リクエストタイムアウトの場合は408エラーを返す
      }
      this.processing = false; // 処理中フラグをリセット
      // 次のリクエストを処理
      setTimeout(() => this.processNext(), 5); // 5ms後に次のリクエストを処理
    }, 8000); // 8秒でタイムアウト

    try {
      const processingMode = this.stack.length <= 25 ? 'FIFO' : 'LIFO'; // 処理方式を取得
      logger.info(`[スタック処理開始][${processingMode}] ${requestInfo.displayPath} (残り: ${this.stack.length})`);

      // 最後の処理時刻を更新
      this.lastProcessTime = Date.now(); // 最後の処理時刻を更新

      // リクエスト処理を実行（タイムアウト付き）
      await Promise.race([
        requestInfo.processor(), // リクエスト処理を実行
        new Promise((_, reject) => setTimeout(() => reject(new Error('Processor timeout')), 6000)) // 6秒でタイムアウト
      ]);

      clearTimeout(timeoutId);
      this.processedCount++; // 処理済みリクエスト数を更新
      this.lastProcessTime = Date.now(); // 完了時刻も更新
      logger.info(`[スタック処理完了] ${requestInfo.displayPath} (処理済み: ${this.processedCount})`);

    } catch (error) {
      clearTimeout(timeoutId);
      logger.error(`[スタック処理エラー] ${requestInfo.displayPath}: ${error.message}`); // ログを出力

      // エラー時は適切なレスポンスを送信
      if (requestInfo.res && !requestInfo.res.headersSent) {
        requestInfo.res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); // 500エラーを返す
        requestInfo.res.end('Internal server error'); // 内部サーバーエラーの場合は500エラーを返す
      }
    } finally {
      this.processing = false; // 処理中フラグをリセット

      // スタックに残りのリクエストがあれば次の処理を開始
      if (this.stack.length > 0) {
        // 次の処理を少し遅延させてCPU負荷を軽減
        setTimeout(() => this.processNext(), 5); // 5ms後に次のリクエストを処理
      }
    }
  }

  // スタック監視を開始
  startStuckMonitoring() {
    this.stuckCheckInterval = setInterval(() => { // 3秒間隔でチェック
      const now = Date.now(); // 現在時刻を取得
      const timeSinceLastProcess = now - this.lastProcessTime; // 最後の処理時刻からの経過時間を取得

      // 処理中で5秒以上経過している場合は強制復旧（より積極的）
      if (this.processing && timeSinceLastProcess > 5000) { // 処理中で5秒以上経過している場合
        logger.warn(`[スタック強制復旧] 処理が5秒以上停止しています - 強制復旧を実行`);
        this.forceRecovery(); // 強制復旧
      }

      // スタックが30個以上溜まっている場合は警告
      if (this.stack.length > 30) { // スタックが30個以上溜まっている場合
        logger.warn(`[スタック警告] スタックが${this.stack.length}個に達しています`); // ログを出力
      }

      // スタックが60個以上溜まっている場合は積極的破棄
      if (this.stack.length > 60) { // スタックが60個以上溜まっている場合
        const removeCount = Math.floor(this.stack.length * 0.3); // 30%破棄
        for (let i = 0; i < removeCount; i++) { // 30%破棄
          const removed = this.stack.shift(); // 古いリクエストを削除
          if (removed && removed.res && !removed.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
            removed.res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); // 503エラーを返す
            removed.res.end('Request stack emergency clear. Please retry.'); // リクエストスタック緊急破棄の場合は503エラーを返す
          }
        }
        logger.warn(`[スタック緊急破棄] ${removeCount}件のリクエストを破棄 (残り: ${this.stack.length})`); // ログを出力
        this.forceRecovery(); // 強制復旧
      }

      // スタックが100個以上溜まっている場合は強制復旧
      if (this.stack.length > 100) { // スタックが100個以上溜まっている場合
        logger.warn(`[スタック緊急復旧] スタックが${this.stack.length}個に達しています - 緊急復旧を実行`); // ログを出力
        this.forceRecovery(); // 強制復旧
      }
    }, 3000); // 3秒間隔でチェック（より頻繁に監視）
  }

  // 強制復旧処理
  forceRecovery() {
    logger.error(`[スタック強制復旧実行] 処理中フラグをリセット`); // ログを出力
    this.processing = false; // 処理中フラグをリセット
    this.lastProcessTime = Date.now(); // 最後の処理時刻を更新

    // 次のリクエストを処理
    setTimeout(() => this.processNext(), 100); // 100ms後に次のリクエストを処理
  }

  // スタックの状態を取得
  getStatus() {
    return {
      stackSize: this.stack.length, // スタックサイズを取得
      processing: this.processing, // 処理中フラグを取得
      processedCount: this.processedCount, // 処理済みリクエスト数を取得
      maxStackSize: this.maxStackSize, // スタックの最大サイズを取得
      timeSinceLastProcess: Date.now() - this.lastProcessTime, // 最後の処理時刻からの経過時間を取得
      currentFolder: this.currentFolder, // 現在のフォルダパスを取得
      folderChangeCount: this.folderChangeCount // フォルダ変更回数を取得
    };
  }

  // パスからフォルダを抽出
  extractFolderFromPath(displayPath) {
    // パスからフォルダ部分を抽出
    const pathParts = displayPath.split('/'); // パスを分割
    if (pathParts.length <= 2) { // ルートレベルの場合
      return displayPath; // ルートレベルの場合はパスをそのまま返す
    }
    // 最後の要素（ファイル名）を除いた部分をフォルダパスとする
    return pathParts.slice(0, -1).join('/'); // フォルダパスを取得
  }

  // フォルダ変更時のスタッククリア
  clearStackForFolderChange(newFolder) {
    this.folderChangeCount++; // フォルダ変更回数を更新
    const clearedCount = this.stack.length; // スタックサイズを取得

    // スタック内のすべてのリクエストにエラーレスポンスを送信
    this.stack.forEach(requestInfo => {
      if (requestInfo.res && !requestInfo.res.headersSent) { // リクエストが存在し、レスポンスが送信されていない場合
        requestInfo.res.writeHead(410, {
          'Content-Type': 'text/plain; charset=utf-8', // テキスト/プレーンテキスト、UTF-8エンコーディング
          'Cache-Control': 'no-cache' // キャッシュを無効化
        });
        requestInfo.res.end('Request cancelled due to folder change'); // リクエストがキャンセルされた場合は410エラーを返す
      }
    });

    this.stack = []; // スタックをクリア

    this.processing = false; // 処理中フラグをリセット

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
        const processingMode = stackStatus.stackSize <= 25 ? 'FIFO' : 'LIFO';
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
