const webdav = require("webdav-server").v2;

const server = new webdav.WebDAVServer({
  rootFileSystem: new webdav.PhysicalFileSystem("Z:/"),
});

// サーバー起動
server.start(1901, () => {
  console.log("🚀 WebDAV サーバー起動：http://localhost:1901/");
});
