#!/usr/bin/env node
/**
 * SomniSync mock IoT simulator (Node.js 18+, no npm dependencies).
 *
 * Run in PowerShell:
 *   node .\somnisync_sim.js
 *
 * Optional Twilio configuration (live calls are selected from the presenter panel):
 *   $env:ACCOUNT_SID="your_account_sid"
 *   $env:AUTH_TOKEN="your_auth_token"
 *   $env:EMERGENCY_CONTACT="+..."
 *   node .\somnisync_sim.js
 *
 * The script serves the dashboard and its API at http://127.0.0.1:3000.
 * Do not open the HTML through file://; use the local URL above.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const CONFIG = Object.freeze({
  accountSid: process.env.ACCOUNT_SID || "",
  authToken: process.env.AUTH_TOKEN || "",
  emergencyContact: process.env.EMERGENCY_CONTACT || "",
  port: Number(process.env.PORT || "3000"),
  readingIntervalMs: 3000,
  escalationDelaySeconds: 15,
});

const dashboardPath = path.join(__dirname, "somnisync_v2.html");

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
  return {
    event: "call-mode",
    mode: callMode,
    liveAvailable: !getTwilioConfigError(),
    locked: state === "EMERGENCY",
    ...(getTwilioConfigError() ? { unavailableReason: getTwilioConfigError() } : {}),
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

function getTwilioConfigError() {
  if (!/^AC[0-9a-fA-F]{32}$/.test(CONFIG.accountSid)) {
    return "ACCOUNT_SID must be a valid Twilio Account SID.";
  }
  if (!CONFIG.authToken) return "AUTH_TOKEN is not set.";
  if (!/^\+[1-9]\d{6,14}$/.test(CONFIG.emergencyContact)) {
    return "EMERGENCY_CONTACT must be in E.164 format (for example, +15551234567).";
  }
  return "";
}

async function placeEmergencyCall() {
  log("15 seconds elapsed; emergency escalation is active.");
  if (callMode === "dry-run") {
    log("DRY RUN: no phone call was placed.");
    broadcast({ event: "call-status", status: "dry-run", message: "Dry run · no call placed" });
    return;
  }

  const configError = getTwilioConfigError();
  if (configError) {
    log(`Twilio call not placed: ${configError}`);
    broadcast({ event: "call-status", status: "error", message: configError });
    return;
  }

  broadcast({ event: "call-status", status: "placing", message: "Connecting emergency call…" });
  const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.accountSid}/Calls.json`;
  const authorization = Buffer.from(`${CONFIG.accountSid}:${CONFIG.authToken}`).toString("base64");
  const body = new URLSearchParams({
    To: CONFIG.emergencyContact,
    Url: "https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech",
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const responseBody = await response.text();
    let result;
    try {
      result = JSON.parse(responseBody);
    } catch {
      result = null;
    }

    if (!response.ok) {
      log(`Twilio call failed: HTTP ${response.status} ${result?.message || response.statusText}`);
      broadcast({
        event: "call-status",
        status: "error",
        message: `Twilio call failed (HTTP ${response.status}).`,
      });
      return;
    }
    log(`Twilio accepted the trial-compatible call request (status: ${result?.status || "unknown"}).`);
    broadcast({
      event: "call-status",
      status: "accepted",
      message: "Twilio accepted the call request. The verified recipient may receive a call with Twilio's standard trial prompt.",
    });
  } catch (error) {
    log(`Twilio request failed: ${error.message}`);
    broadcast({ event: "call-status", status: "error", message: "Could not connect to Twilio." });
  }
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
      broadcast({ event: "call-status", status: "cancelled", message: "Emergency call cancelled" });
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
  return origin === `http://localhost:${CONFIG.port}` || origin === `http://127.0.0.1:${CONFIG.port}`;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const origin = request.headers.origin;
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
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.writeHead(204);
    response.end();
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
      response.end(html);
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
        const configError = getTwilioConfigError();
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
        liveAvailable: !getTwilioConfigError(),
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
    broadcast({ event: "call-status", status: "cancelled", message: "Emergency call cancelled" });
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
  console.log("DRY RUN — no phone calls will be placed. Select a mode in the presenter panel.");
  server.listen(CONFIG.port, "127.0.0.1", () => {
    log(`Dashboard event stream ready at http://127.0.0.1:${CONFIG.port}/events`);
    log(`Open the dashboard at http://127.0.0.1:${CONFIG.port}/`);
    setupKeyboard();
    enterNormal();
  });
}

process.on("SIGINT", shutdown);
