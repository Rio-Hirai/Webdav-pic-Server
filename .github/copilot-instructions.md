# Webdav-pic-Server — Copilot instructions (short & actionable)

Note: If you edit this file, also update `.github/copilot-instructions.ja.md` (Japanese translation) to keep them in sync.

This repo is a single-process Node.js WebDAV image conversion server. Images are converted on-demand by Sharp with ImageMagick fallback (HEIC/HEIF). Settings are loaded dynamically from `config.txt` every 10s. Key code is under `.core/` and `main.js`.

What to know before editing:
- `main.js`: start-up, `configureSharp()`, config watcher, and restart hooks
- `.core/config.js`: validation & dynamic config getters (source of truth: `config.txt`)
- `.core/image.js`: `convertAndRespond`, `reinitializeConcurrency`, in-flight dedupe, p-limit
- `.core/webdav.js`: WebDAV routing, `safeResolve` (path traversal), `IMAGE_EXTS`, cache wrappers
- `.core/cache.js`: file/LRU cache, TTL, atomic writes

Quick run & debug commands:
- `npm run start` (foreground), `npm run start:bg` (Windows background)
- `node test.js` (simple test server on port 1901)
- `npm run logs` (PowerShell log tail), `npm run status` (netstat check)
- Edit `config.txt` then wait ≤10s for auto-apply

Common agent tasks & rules:
- Small, localized changes only: modify code in `.core/*` for behavioral changes; update `config.txt` for runtime tuning
- When changing concurrency/memory, update both `configureSharp()` in `main.js` and `p-limit` init in `.core/image.js`
- When altering cache behavior, check SHA-256 cache key generation and Windows path length handling (`.core/webdav.js` + `.core/cache.js`)
- Any change touching path resolution or access controls must use `safeResolve` and include tests for path traversal and platform differences
- Write user-facing explanations and comments in Japanese; leave technical commands, filenames, and code snippets in English.
- If you change the UI, update `public/settings.html` as well (the settings page).
- When changing concurrency or Sharp settings, update `configureSharp()` in `main.js` and the `p-limit` init (`reinitializeConcurrency()`) in `.core/image.js` and test the change.
- When changing path resolution, follow `safeResolve` and test at least three path traversal attack patterns (examples: `../`, URL‑encoded `%2e%2e/`, mixed separators `..\\`).

Testing checklist (manual):
- Start server: `npm run start` or `node main.js`
- Request an image: `curl -I http://localhost:1900/path/to/image.jpg?q=80` → expect `200` and `Content-Type: image/webp`
- Test HEIC fallback: request an HEIC image; ensure ImageMagick is installed and `MAGICK_PATH` is set
- Confirm settings reload: change `config.txt` and observe Sharp/config re-apply in logs within 10s

Dependencies and environment:
- Needs Node.js >=25
- `sharp` (0.34.4), `webdav-server`, `p-limit`, `lru-cache`; ImageMagick for HEIC

- **エージェントの応答言語（必須）**: ユーザー向けの説明・コメント・要約は日本語で出力してください。コマンド、ファイル名、コードのスニペットなどの技術的表記は英語のままでも構いません。
- **Preferred language for chat replies**: Provide user-facing explanations, comments, and summaries in Japanese. It's acceptable to keep technical commands, filenames, and code snippets in English. (チャットの説明やユーザー向けのコメントは日本語で出力してください。コマンドやコードは英語のままで構いません。)

If you want, I can:
- Add PM2 sample start script to `package.json`
- Add a PR template and checklist for changes that impact concurrency/security
