// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Desktop app entry point (Electron).
//
// The window is served by the same request handler as `npm start`, through a privileged app://
// protocol instead of an HTTP port. Nothing else on the machine can reach it, and the fixed origin
// keeps the desk's saved settings from one launch to the next.

import { app, BrowserWindow, Menu, net, protocol, screen, session, shell } from "electron";
import { join } from "node:path";
import { createApp, loadMarketEnvironment } from "../server.mjs";

const SCHEME = "app";
const HOST = "counterline";
const HOME = `${SCHEME}://${HOST}/`;
// Permissions a page may be granted: clipboard writes (rate sheet) and full screen (customer
// display). Everything else is refused.
const PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);
// Pages run sandboxed, with no access to Node or Electron.
const WEB_PREFERENCES = { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false };

let mainWindow = null;

function isOwnPage(address) {
  try {
    const url = new URL(address);
    return url.protocol === `${SCHEME}:` && url.host === HOST;
  } catch {
    return false;
  }
}

// External https links open in the default browser.
function openOutside(address) {
  if (/^https:\/\//i.test(address)) shell.openExternal(address);
}

function showMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(940, height),
    minWidth: 380,
    minHeight: 560,
    show: false, // shown once the first page has been drawn, so it never opens blank
    title: app.name,
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.loadURL(HOME);
  mainWindow = window;
}

function appMenu() {
  return Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
}

async function start() {
  // An EIA API key is optional. An installed copy looks for it in its own data folder; run from
  // the project folder, the app reads .env there, as `npm start` does.
  await loadMarketEnvironment(app.isPackaged ? join(app.getPath("userData"), "settings.env") : undefined);
  // Market data is fetched through Chromium, so the computer's proxy settings and certificates apply.
  const desk = createApp({ fetchImpl: (input, init) => net.fetch(String(input), init) });
  desk.warmUp();

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });
    const { status, headers, body } = await desk.respond(request.method, url.pathname + url.search);
    return new Response(body, { status, headers });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, decide) => decide(PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => PERMISSIONS.has(permission));
  Menu.setApplicationMenu(appMenu());
  showMainWindow();
  // Opening the app a second time brings the running copy forward instead.
  app.on("second-instance", showMainWindow);
  // macOS keeps an app running without windows; clicking its Dock icon opens the desk again.
  app.on("activate", showMainWindow);
}

// Before the app is ready: makes app:// behave like https:// for the pages, so that relative
// links, fetch and saved settings all work.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

app.on("web-contents-created", (_event, contents) => {
  // The customer display is the one page that opens a window of its own.
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwnPage(url)) return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: WEB_PREFERENCES } };
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isOwnPage(url)) return;
    event.preventDefault();
    openOutside(url);
  });
});

// Only one copy of the app runs at a time.
if (app.requestSingleInstanceLock()) {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.whenReady().then(start);
} else {
  app.quit();
}
