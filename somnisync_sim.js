#!/usr/bin/env node
/**
 * SomniSync mock IoT simulator (Node.js 18+, no npm dependencies).
 *
 * Run in PowerShell:
 *   node .\somnisync_sim.js
 *
 * Optional Telegram user-to-user Voice configuration (live calls are selected
 * from the presenter panel): TELEGRAM_API_ID, TELEGRAM_API_HASH and
 * TELEGRAM_CALL_TO are read from the server process environment. The sender
 * must complete a one-time Telegram user login with start_somnisync_live.ps1.
 *
 * The script serves the dashboard and its API at http://127.0.0.1:3000.
 * Do not open the HTML through file://; use the local URL above.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const CONFIG = Object.freeze({
  telegramApiId: process.env.TELEGRAM_API_ID || "",
  telegramApiHash: process.env.TELEGRAM_API_HASH || "",
  telegramCallTo: process.env.TELEGRAM_CALL_TO || "",
  pythonPath: process.env.TELEGRAM_PYTHON_PATH || (process.platform === "win32"
    ? path.join(__dirname, ".venv-telegram", "Scripts", "python.exe")
    : "python3"),
  telegramSessionPath: process.env.TELEGRAM_SESSION_PATH || path.join(__dirname, "somnisync_telegram_user.session"),
  telegramSessionString: process.env.TELEGRAM_SESSION_STRING || "",
  telegramAlertFile: process.env.TELEGRAM_ALERT_FILE || path.join(__dirname, "somnisync_emergency.wav"),
  telegramCallScript: path.join(__dirname, "telegram_voice_call.py"),
  port: Number(process.env.PORT || "3000"),
  host: process.env.HOST || (process.env.ALLOW_REMOTE === "true" ? "0.0.0.0" : "127.0.0.1"),
  allowRemote: process.env.ALLOW_REMOTE === "true",
  escalationDelaySeconds: 15,
});

const dashboardPath = path.join(__dirname, "somnisync_v2.html");
const apiToken = crypto.randomBytes(32).toString("hex");

let state = "NORMAL";
let readingTimer = null;
let countdownTimer = null;
let callStarted = false;
let shuttingDown = false;
let lineReader = null;
let currentHeartRate = null;
let currentAngle = 0;
let currentTemperature = 24;
let escalationDeadline = null;
let latestCallStatus = null;
let callMode = "dry-run";
const eventClients = new Set();
let activeTelegramCall = null;

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const log = (message) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

function clearTimers() {
  if (readingTimer) clearInterval(readingTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  readingTimer = null;
  countdownTimer = null;
}

function broadcast(event) {
  if (event.event === "call-status") latestCallStatus = event;
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) {
    client.write(message);
  }
}

function getCallModeStatus() {
  const unavailableReason = getTelegramConfigError();
  return {
    event: "call-mode",
    mode: callMode,
    liveAvailable: !unavailableReason,
    locked: state === "EMERGENCY",
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function emitReading(heartRate) {
  currentHeartRate = heartRate;
  const status = state === "NORMAL" ? "NORMAL" : state === "EMERGENCY" ? "CRITICAL" : "RECOVERING";
  log(`Heart rate: ${heartRate} bpm (${status})`);
  broadcast({ event: "reading", hr: heartRate, status, timestamp: new Date().toISOString() });
}

function enterNormal(reason = "", { broadcastState = true } = {}) {
  clearTimers();
  state = "NORMAL";
  callStarted = false;
  latestCallStatus = null;
  currentAngle = 0;
  currentTemperature = 24;
  escalationDeadline = null;
  log(`STATE 1 — NORMAL${reason ? ` (${reason})` : ""}`);
  broadcast({ event: broadcastState ? "normal" : "emergency-cancelled" });
  broadcast(getCallModeStatus());
  broadcast({ event: "intervention", angle: currentAngle, temp: currentTemperature });
  emitReading(randomInt(65, 75));
  readingTimer = setInterval(() => emitReading(randomInt(65, 75)), CONFIG.readingIntervalMs);
}

function getTelegramConfigError() {
  if (!/^\d+$/.test(CONFIG.telegramApiId)) return "Telegram API ID is missing or invalid.";
  if (!/^[0-9a-fA-F]{32}$/.test(CONFIG.telegramApiHash)) return "Telegram API hash is missing or invalid.";
  if (!/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(CONFIG.telegramCallTo)) return "Recipient must be a Telegram @username.";
  if (!fs.existsSync(CONFIG.pythonPath)) return `Telegram Python runtime was not found at ${CONFIG.pythonPath}.`;
  if (!CONFIG.telegramSessionString && !fs.existsSync(CONFIG.telegramSessionPath)) return "The Telegram sender account has not been signed in yet. Set TELEGRAM_SESSION_STRING or provide a session file.";
  if (!fs.existsSync(CONFIG.telegramAlertFile)) return "The emergency WAV file is missing.";
  if (!fs.existsSync(CONFIG.telegramCallScript)) return "telegram_voice_call.py is missing.";
  return "";
}

async function placeEmergencyCall() {
  log("15 seconds elapsed; emergency escalation is active.");
  if (callMode === "dry-run") {
    log("DRY RUN: no Telegram call was placed.");
    broadcast({ event: "call-status", status: "dry-run", message: "Demo only · no Telegram call placed" });
    return;
  }

  const configError = getTelegramConfigError();
  if (configError) {
    log(`Telegram call not placed: ${configError}`);
    broadcast({ event: "call-status", status: "error", message: configError });
    return;
  }

  broadcast({ event: "call-status", status: "placing", message: `Starting a Telegram call to ${CONFIG.telegramCallTo}…` });
  const child = spawn(CONFIG.pythonPath, [CONFIG.telegramCallScript, "--call"], {
    cwd: __dirname,
    env: {
      ...process.env,
      TELEGRAM_SESSION_PATH: CONFIG.telegramSessionPath,
      TELEGRAM_SESSION_STRING: CONFIG.telegramSessionString,
      TELEGRAM_ALERT_FILE: CONFIG.telegramAlertFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  activeTelegramCall = child;
  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event && event.status && event.message) {
          log(`Telegram call: ${event.message}`);
          broadcast({ event: "call-status", status: event.status, message: event.message });
        }
      } catch {
        if (line.trim()) log(`Telegram call: ${line.trim()}`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const details = chunk.trim();
    if (details) log(`Telegram call detail: ${details}`);
  });
  child.on("error", (error) => {
    log(`Telegram call could not start: ${error.message}`);
    broadcast({ event: "call-status", status: "error", message: "Could not start the Telegram call service." });
    activeTelegramCall = null;
  });
  child.on("exit", (code) => {
    if (activeTelegramCall === child) activeTelegramCall = null;
    if (code !== 0 && state !== "NORMAL") {
      log(`Telegram call process ended with code ${code}.`);
      broadcast({ event: "call-status", status: "error", message: "Telegram call ended before it could be completed. Check the server log." });
    }
  });
}

function enterEmergency() {
  clearTimers();
  state = "EMERGENCY";
  callStarted = false;
  latestCallStatus = null;
  currentAngle = 12;
  currentTemperature = 19;
  escalationDeadline = Date.now() + CONFIG.escalationDelaySeconds * 1000;
  log("STATE 2 — EMERGENCY & ESCALATION");

  broadcast({ event: "emergency", remainingSeconds: CONFIG.escalationDelaySeconds });
  broadcast(getCallModeStatus());
  broadcast({ event: "intervention", angle: currentAngle, temp: currentTemperature });
  emitReading(randomInt(125, 140));
  readingTimer = setInterval(() => emitReading(randomInt(125, 140)), CONFIG.readingIntervalMs);
  log("Abnormal HR detected. Auto-adjusting bed to 12 degrees and lowering temperature...");
  log(`15-second grace period started. Press '1' to cancel.`);

  let secondsRemaining = CONFIG.escalationDelaySeconds;
  countdownTimer = setInterval(() => {
    if (state !== "EMERGENCY") {
      clearTimers();
      return;
    }

    secondsRemaining -= 1;
    if (secondsRemaining > 0) {
      log(`Emergency call in ${secondsRemaining}s. Press '1' to cancel.`);
      return;
    }

    clearInterval(countdownTimer);
    countdownTimer = null;
    if (state === "EMERGENCY" && !callStarted) {
      callStarted = true;
      enterAutoPilot();
      void placeEmergencyCall();
    }
  }, 1000);
}

function enterAutoPilot() {
  clearTimers();
  state = "AUTOPILOT";
  currentAngle = 12;
  currentTemperature = 19;
  escalationDeadline = null;
  broadcast({ event: "autopilot" });
  broadcast(getCallModeStatus());
  broadcast({ event: "intervention", angle: currentAngle, temp: currentTemperature });
  emitReading(90);
}

function handleKey(key) {
  if (key === "1") {
    if (state === "EMERGENCY") {
      enterNormal("emergency cancelled", { broadcastState: false });
      broadcast({ event: "call-status", status: "cancelled", message: "Emergency alert cancelled" });
    } else {
      log("Already in NORMAL state.");
    }
  } else if (key === "2") {
    if (state === "NORMAL") {
      enterEmergency();
    } else {
      log("Already in EMERGENCY state. Press '1' to cancel.");
    }
  } else if (key.toLowerCase() === "q") {
    shutdown();
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimers();
  if (activeTelegramCall) {
    activeTelegramCall.kill();
    activeTelegramCall = null;
  }
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  if (lineReader) lineReader.close();
  process.stdin.pause();
  for (const client of eventClients) client.end();
  eventClients.clear();
  if (server.listening) server.close();
  log("SomniSync simulator stopped.");
  process.exitCode = 0;
}

function isAllowedBrowserOrigin(origin) {
  if (!origin) return true;
  if (CONFIG.allowRemote) return true;
  return origin === `http://localhost:${CONFIG.port}` || origin === `http://127.0.0.1:${CONFIG.port}`;
}

function isAllowedHost(host) {
  if (CONFIG.allowRemote) return true;
  return host === `localhost:${CONFIG.port}` || host === `127.0.0.1:${CONFIG.port}`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const origin = request.headers.origin;
  if (!isAllowedHost(request.headers.host || "")) {
    sendJson(response, 403, { error: "Host is not allowed." });
    return;
  }
  if (!isAllowedBrowserOrigin(origin)) {
    sendJson(response, 403, { error: "Origin is not allowed." });
    return;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-SomniSync-Token");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && request.headers["x-somnisync-token"] !== apiToken) {
    sendJson(response, 403, { error: "Local dashboard token is missing or invalid." });
    return;
  }

  if (request.method === "GET" && pathname === "/healthz") {
    sendJson(response, 200, {
      ok: true,
      telegramConfigured: !getTelegramConfigError(),
      telegramConfigError: getTelegramConfigError() || null,
      state,
    });
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/somnisync_v2.html")) {
    fs.readFile(dashboardPath, (error, html) => {
      if (error) {
        log(`Could not read dashboard HTML: ${error.message}`);
        sendJson(response, 500, { error: "Dashboard file could not be loaded." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
      });
      response.end(html.toString("utf8").replace("__SOMNISYNC_API_TOKEN__", apiToken));
    });
    return;
  }

  if (request.method === "GET" && pathname === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.setTimeout(0);
    response.write("retry: 2000\n\n");
    eventClients.add(response);
    response.write(`data: ${JSON.stringify({
      event: state === "EMERGENCY" ? "emergency" : state === "AUTOPILOT" ? "autopilot" : "normal",
      ...(state === "EMERGENCY" && escalationDeadline
        ? { remainingSeconds: Math.max(0, Math.ceil((escalationDeadline - Date.now()) / 1000)) }
        : {}),
    })}\n\n`);
    response.write(`data: ${JSON.stringify({ event: "intervention", angle: currentAngle, temp: currentTemperature })}\n\n`);
    response.write(`data: ${JSON.stringify(getCallModeStatus())}\n\n`);
    if (currentHeartRate !== null) {
      response.write(`data: ${JSON.stringify({ event: "reading", hr: currentHeartRate })}\n\n`);
    }
    if (latestCallStatus) response.write(`data: ${JSON.stringify(latestCallStatus)}\n\n`);
    response.on("close", () => eventClients.delete(response));
    return;
  }

  if (request.method === "POST" && pathname === "/api/emergency/start") {
    if (state !== "EMERGENCY") enterEmergency();
    sendJson(response, 200, { state, callMode });
    return;
  }

  if (request.method === "POST" && pathname === "/api/call-mode") {
    if (state === "EMERGENCY") {
      sendJson(response, 409, { error: "Call mode cannot be changed during an active emergency." });
      return;
    }

    let body = "";
    let bodyTooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024) bodyTooLarge = true;
    });
    request.on("end", () => {
      if (bodyTooLarge) {
        sendJson(response, 413, { error: "Call mode request is too large." });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "A valid JSON call mode is required." });
        return;
      }

      if (!payload || typeof payload !== "object" || (payload.mode !== "dry-run" && payload.mode !== "live")) {
        sendJson(response, 400, { error: "Call mode must be either 'dry-run' or 'live'." });
        return;
      }
      if (payload.mode === "live") {
        const configError = getTelegramConfigError();
        if (configError) {
          sendJson(response, 400, { error: `Live calls are unavailable: ${configError}` });
          return;
        }
      }

      callMode = payload.mode;
      broadcast(getCallModeStatus());
      log(`Emergency call mode set to ${callMode === "live" ? "LIVE" : "DRY RUN"}.`);
      sendJson(response, 200, {
        mode: callMode,
        liveAvailable: !getTelegramConfigError(),
        locked: state === "EMERGENCY",
      });
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/emergency/cancel") {
    if (state !== "EMERGENCY") {
      sendJson(response, 200, { state, cancelled: false });
      return;
    }
    if (callStarted) {
      sendJson(response, 409, { error: "The call has already been initiated and cannot be cancelled here." });
      return;
    }
    enterNormal("dashboard cancelled", { broadcastState: false });
    broadcast({ event: "call-status", status: "cancelled", message: "Emergency alert cancelled" });
    sendJson(response, 200, { state, cancelled: true });
    return;
  }

  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("SomniSync simulator is running. Connect to /events for live data.\n");
});

server.on("error", (error) => {
  log(`Dashboard event server failed: ${error.message}`);
  shuttingDown = true;
  clearTimers();
  process.stdin.pause();
  process.exitCode = 1;
});

function setupKeyboard() {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (input, key) => {
      if (key?.ctrl && key.name === "c") {
        shutdown();
      } else {
        handleKey(input);
      }
    });
    process.stdin.resume();
    return;
  }

  lineReader = readline.createInterface({ input: process.stdin });
  lineReader.on("line", (line) => handleKey(line.trim()));
  lineReader.on("close", () => {
    if (!shuttingDown) log("Terminal input closed; the local dashboard server remains active.");
  });
}

console.log("SomniSync — Mock IoT Mattress Simulator");
console.log("Keys: [1] Normal / cancel emergency  [2] Emergency  [q] Quit");
if (!Number.isInteger(CONFIG.port) || CONFIG.port < 1 || CONFIG.port > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exitCode = 1;
} else {
  console.log("DRY RUN — no Telegram calls will be placed. Select a mode in the presenter panel.");
  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`Dashboard event server ready at http://${CONFIG.host}:${CONFIG.port}`);
    log(`Open the dashboard at http://127.0.0.1:${CONFIG.port}/`);
    setupKeyboard();
    enterNormal();
  });
}

process.on("SIGINT", shutdown);
