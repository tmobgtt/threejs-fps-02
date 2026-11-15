// A tiny static file server for playing the game locally and for taking
// its screenshots: node serve.ts [port] serves game/ at http://localhost.
//
// Standard library only. It sends the few MIME types the game uses and
// never serves anything outside game/.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "game");
const port = Number(process.argv[2] ?? 8123);
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const file = join(root, path === "/" ? "index.html" : path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end("outside the yard");
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end("no such crate");
  }
}).listen(port, () => console.log(`yardline served at http://localhost:${port}`));
