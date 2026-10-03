import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createReferenceService } from "./src/server/reference-service.mjs";
import { fetchFrankfurterCurrencies } from "./src/server/frankfurter-provider.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const referenceService = createReferenceService();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let currencyCache;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function parsePairs(value) {
  if (!value || value.length > 1200) return null;
  const entries = value.split("|");
  if (entries.length > 30) return null;
  const pairs = [];
  for (const entry of entries) {
    const match = /^([A-Z]{3}):([A-Z]{3})$/.exec(entry);
    if (!match || match[1] === match[2]) return null;
    pairs.push({ base: match[1], quote: match[2] });
  }
  return pairs.length ? pairs : null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (url.pathname === "/api/rates") {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    if (!pairs) {
      sendJson(response, 400, { error: "Provide up to 30 currency pairs as BASE:QUOTE entries." });
      return;
    }
    try {
      sendJson(response, 200, await referenceService.getRates(pairs));
    } catch {
      sendJson(response, 503, { error: "Reference data is unavailable. Try again shortly." });
    }
    return;
  }

  if (url.pathname === "/api/currencies") {
    const now = Date.now();
    if (currencyCache && currencyCache.expiresAt > now) {
      sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "cached" });
      return;
    }
    try {
      const currencies = await fetchFrankfurterCurrencies();
      currencyCache = { currencies, expiresAt: now + 12 * 60 * 60 * 1000 };
      sendJson(response, 200, { currencies, cacheStatus: "fresh" });
    } catch {
      if (currencyCache) {
        sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "stale-cache" });
      } else {
        sendJson(response, 503, { error: "Currency coverage is unavailable. Try again shortly." });
      }
    }
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(root, `.${requested}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Counterline FX Desk running at http://${host}:${port}`);
});

