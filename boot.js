// Entry point. Storage init is async (PostgreSQL), but the route module
// reads the `db` object synchronously at load time — so we finish loading
// state BEFORE server.js is required. Keep starting the app via this file
// (`npm run dev` / `npm start`), never `node server.js` directly.
const { init } = require("./store");

init().then(() => {
  require("./server");
});
