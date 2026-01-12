// === ファイルシステムラッパーモジュール ===
// グローバル変数の副作用を避けるため、キャッシュ機能付きのfsラッパーを提供
const fs = require("fs");
const path = require("path");
const { LRUCache } = require("lru-cache");

/**
 * ファイルシステムラッパークラス
 * キャッシュ機能付きのファイルシステム操作を提供し、グローバル変数の副作用を避ける
 */
class CachedFileSystemWrapper {
  /**
   * コンストラクタ
   * @param {LRUCache} dirCache - ディレクトリリストキャッシュ
   * @param {LRUCache} statCache - ファイル統計情報キャッシュ
   * @param {Function} getMaxList - 最大リスト数取得関数
   */
  constructor(dirCache, statCache, getMaxList) {
    this.dirCache = dirCache;
    this.statCache = statCache;
    this.getMaxList = getMaxList;
    
    // 元の関数を保存
    this.origReaddirSync = fs.readdirSync;
    this.origStatSync = fs.statSync;
    this.origReaddirP = fs.promises.readdir.bind(fs.promises);
    this.origStatP = fs.promises.stat.bind(fs.promises);
  }

  /**
   * 同期ディレクトリ読み込み（キャッシュ付き）
   * @param {string} dir - ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {string[]} ディレクトリ内のファイル名配列
   */
  readdirSync(dir, opts) {
    const cached = this.dirCache.get(dir);
    if (cached) return cached.slice(0, this.getMaxList());

    let names = [];
    try {
      const dirHandle = fs.opendirSync(dir);
      let entry;
      while ((entry = dirHandle.readSync()) !== null && names.length < this.getMaxList()) {
        names.push(entry.name);
      }
      dirHandle.closeSync();
    } catch {
      names = this.origReaddirSync(dir, opts).slice(0, this.getMaxList());
    }

    try {
      this.dirCache.set(dir, names);
    } catch (e) {
      // キャッシュ保存エラーは警告ログを出力
      const { logger } = require("./config");
      logger.warn(`[キャッシュ保存エラー] readdirSync ${dir}: ${e.message}`);
    }

    return names;
  }

  /**
   * 同期ファイル統計情報取得（キャッシュ付き）
   * @param {string} p - ファイル/ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Object} ファイル統計情報オブジェクト
   */
  statSync(p, opts) {
    const cached = this.statCache.get(p);
    if (cached) return cached;

    try {
      const stat = this.origStatSync(p, opts);
      try {
        this.statCache.set(p, stat);
      } catch (e) {
        const { logger } = require("./config");
        logger.warn(`[キャッシュ保存エラー] statSync ${p}: ${e.message}`);
      }
      return stat;
    } catch {
      return {
        isFile: () => false,
        isDirectory: () => false,
        mtimeMs: 0,
        size: 0,
      };
    }
  }

  /**
   * 非同期ディレクトリ読み込み（キャッシュ付き）
   * @param {string} dir - ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Promise<string[]>} ディレクトリ内のファイル名配列
   */
  async readdir(dir, opts) {
    const cached = this.dirCache.get(dir);
    if (cached) return cached.slice(0, this.getMaxList());

    let names = [];
    try {
      const dirHandle = await fs.promises.opendir(dir);
      for await (const entry of dirHandle) {
        names.push(entry.name);
        if (names.length >= this.getMaxList()) break;
      }
      await dirHandle.close();
    } catch {
      names = await this.origReaddirP(dir, opts);
    }

    try {
      this.dirCache.set(dir, names);
    } catch (e) {
      const { logger } = require("./config");
      logger.warn(`[キャッシュ保存エラー] readdir ${dir}: ${e.message}`);
    }

    return names;
  }

  /**
   * 非同期ファイル統計情報取得（キャッシュ付き）
   * @param {string} p - ファイル/ディレクトリパス
   * @param {Object} opts - オプション
   * @returns {Promise<Object>} ファイル統計情報オブジェクト
   */
  async stat(p, opts) {
    const cached = this.statCache.get(p);
    if (cached) return cached;

    try {
      const stat = await this.origStatP(p, opts);
      try {
        this.statCache.set(p, stat);
      } catch (e) {
        const { logger } = require("./config");
        logger.warn(`[キャッシュ保存エラー] stat ${p}: ${e.message}`);
      }
      return stat;
    } catch {
      return {
        isFile: () => false,
        isDirectory: () => false,
        mtimeMs: 0,
        size: 0,
      };
    }
  }
}

module.exports = {
  CachedFileSystemWrapper,
};
