#!/usr/bin/env node
/**
 * SomniSync - Mock IoT Mattress Simulator
 * ---------------------------------------
 * Phim '1' -> State 1 (Normal): HR 65-75 bpm, gui moi vai giay
 * Phim '2' -> State 2 (Emergency): HR 125-140, tu chinh giuong, dem 15s, roi goi Twilio
 * Phim 'q' (hoac Ctrl+C) -> thoat
 *
 * Yeu cau: Node.js 18+ (dung fetch co san, KHONG can npm install).
 *
 * Chay thu (khong goi that):   node somnisync_sim.js
 * Chay that (goi dien Twilio):
 *   Windows (PowerShell):
 *     $env:TWILIO_ACCOUNT_SID="ACxxxx"; $env:TWILIO_AUTH_TOKEN="xxxx"
 *     $env:TWILIO_PHONE_NUMBER="+1xxxxxxxxxx"; $env:EMERGENCY_CONTACT="+84xxxxxxxxx"
 *     node somnisync_sim.js
 *   macOS / Linux:
 *     TWILIO_ACCOUNT_SID=ACxxxx TWILIO_AUTH_TOKEN=xxxx \
 *     TWILIO_PHONE_NUMBER=+1xxxxxxxxxx EMERGENCY_CONTACT=+84xxxxxxxxx \
 *     node somnisync_sim.js
 */

const readline = require("readline");

// ===================== CONFIG =====================
const CONFIG = {
  // --- Twilio (thay bang gia tri that, hoac dat qua bien moi truong) ---
  ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "YOUR_ACCOUNT_SID",
  AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "YOUR_AUTH_TOKEN",
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || "+10000000000", // so Twilio cua ban
  EMERGENCY_CONTACT: process.env.EMERGENCY_CONTACT || "+84000000000", // so nhan cuoc goi (dinh dang E.164)

  // --- Dashboard (tuy chon): neu dien URL, script se POST JSON moi lan co du lieu ---
  DASHBOARD_URL: process.env.DASHBOARD_URL || "", // vd: http://localhost:3000/api/heart-rate

  // --- Thoi gian ---
  SEND_INTERVAL_MS: 3000, // gui du lieu moi 3 giay
  ESCALATION_DELAY_S: 15, // dem nguoc truoc khi goi

  // --- Giong doc (kiem tra lai danh sach voice trong tai lieu Twilio neu bi loi) ---
  VOICE_EN: "Polly.Joanna",
  VOICE_VI: "Google.vi-VN-Standard-A",
};

const MSG_EN =
  "Emergency alert. SomniSync has detected a critical heart rate anomaly. Immediate attention is required.";
const MSG_VI =
  "Cảnh báo khẩn cấp. Hệ thống SomniSync phát hiện nhịp tim bất thường ở mức nguy hiểm. Cần kiểm tra ngay lập tức.";

const DRY_RUN =
  CONFIG.ACCOUNT_SID.startsWith("YOUR_") || CONFIG.AUTH_TOKEN.startsWith("YOUR_");

// ===================== STATE =====================
let state = 1; // 1 = Normal, 2 = Emergency
let streamTimer = null; // setInterval gui HR
let escalationTimer = null; // setTimeout 15s
let countdownTimer = null; // setInterval hien thi dem nguoc
let callPlaced = false; // tranh goi lap trong cung 1 su kien

// ===================== HELPERS =====================
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const ts = () => new Date().toLocaleTimeString("vi-VN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

function clearAllTimers() {
  if (streamTimer) clearInterval(streamTimer);
  if (escalationTimer) clearTimeout(escalationTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  streamTimer = escalationTimer = countdownTimer = null;
}

async function sendToDashboard(payload) {
  if (!CONFIG.DASHBOARD_URL) return;
  try {
    await fetch(CONFIG.DASHBOARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    log(`(!) Khong gui duoc toi dashboard: ${err.message}`);
  }
}

function emitReading(hr, status) {
  const payload = { device: "somnisync-mattress-01", heartRate: hr, status, timestamp: new Date().toISOString() };
  const icon = status === "NORMAL" ? "OK " : "!!!";
  log(`[${icon}] HR = ${hr} bpm (${status})`);
  sendToDashboard(payload); // khong await -> khong chan
}

// ===================== STATE 1: NORMAL =====================
function enterNormal(reason) {
  clearAllTimers();
  state = 1;
  callPlaced = false;
  console.log("\n==============================================");
  log(`STATE 1 - NORMAL ${reason ? "(" + reason + ")" : ""}`);
  console.log("==============================================");

  emitReading(randInt(65, 75), "NORMAL");
  streamTimer = setInterval(() => emitReading(randInt(65, 75), "NORMAL"), CONFIG.SEND_INTERVAL_MS);
}

// ===================== STATE 2: EMERGENCY =====================
function enterEmergency() {
  clearAllTimers(); // dung State 1 ngay lap tuc
  state = 2;
  callPlaced = false;
  console.log("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  log("STATE 2 - EMERGENCY & ESCALATION");
  console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  // Step 1: spike HR
  emitReading(randInt(125, 140), "CRITICAL");
  streamTimer = setInterval(() => emitReading(randInt(125, 140), "CRITICAL"), CONFIG.SEND_INTERVAL_MS);

  // Step 2: can thiep vat ly
  log("Abnormal HR detected. Auto-adjusting bed to 12 degrees and lowering temperature...");

  // Step 3: dem nguoc 15s (non-blocking)
  let remaining = CONFIG.ESCALATION_DELAY_S;
  log(`Dem nguoc ${remaining}s truoc khi goi khan cap. Nhan '1' de huy.`);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0 && remaining % 5 === 0) log(`... con ${remaining}s`);
  }, 1000);

  // Step 4: sau 15s, neu van o State 2 thi goi
  escalationTimer = setTimeout(() => {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    if (state === 2 && !callPlaced) {
      callPlaced = true;
      placeEmergencyCall();
    }
  }, CONFIG.ESCALATION_DELAY_S * 1000);
}

// ===================== TWILIO =====================
function buildTwiml() {
  // Hai the <Say> lien tiep: tieng Anh truoc, tieng Viet sau, trong cung mot cuoc goi
  return (
    `<Response>` +
    `<Say language="en-US" voice="${CONFIG.VOICE_EN}">${MSG_EN}</Say>` +
    `<Pause length="1"/>` +
    `<Say language="vi-VN" voice="${CONFIG.VOICE_VI}">${MSG_VI}</Say>` +
    `</Response>`
  );
}

async function placeEmergencyCall() {
  const twiml = buildTwiml();
  log("ESCALATION: Van o State 2 sau 15s -> goi so khan cap...");

  if (DRY_RUN) {
    log("[DRY-RUN] Chua cau hinh Twilio, KHONG goi that. TwiML se duoc gui:");
    console.log(twiml);
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.ACCOUNT_SID}/Calls.json`;
  const auth = Buffer.from(`${CONFIG.ACCOUNT_SID}:${CONFIG.AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({
    To: CONFIG.EMERGENCY_CONTACT,
    From: CONFIG.TWILIO_PHONE_NUMBER,
    Twiml: twiml,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json();
    if (res.ok) {
      log(`Da goi thanh cong toi ${CONFIG.EMERGENCY_CONTACT} (Call SID: ${data.sid}, status: ${data.status})`);
    } else {
      log(`(!) Twilio bao loi ${res.status}: ${data.message || JSON.stringify(data)}`);
    }
  } catch (err) {
    log(`(!) Loi mang khi goi Twilio: ${err.message}`);
  }
}

// ===================== KEYBOARD =====================
function handleKey(key) {
  if (key === "1") {
    if (state === 2) {
      log("Nguoi dung nhan '1': HUY bao dong, tat moi bo dem gio.");
      enterNormal("da huy canh bao khan cap");
    } else {
      log("Dang o State 1 (Normal) roi.");
    }
  } else if (key === "2") {
    if (state === 1) enterEmergency();
    else log("Dang o State 2 roi. Nhan '1' de huy.");
  } else if (key === "q") {
    shutdown();
  }
}

function shutdown() {
  clearAllTimers();
  console.log("\nTat SomniSync simulator. Tam biet!");
  process.exit(0);
}

function setupKeyboard() {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (key && key.ctrl && key.name === "c") return shutdown();
      handleKey(str);
    });
  } else {
    // Khi pipe input (de test): doc theo dong
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => handleKey(line.trim()));
    rl.on("close", shutdown);
  }
}

// ===================== MAIN =====================
console.log("SomniSync - Mock IoT Mattress Simulator");
console.log("Phim: [1] Normal / Huy bao dong   [2] Emergency   [q] Thoat");
console.log(
  DRY_RUN
    ? "Che do: DRY-RUN (chua co Twilio credentials, se khong goi that)"
    : `Che do: LIVE - se goi toi ${CONFIG.EMERGENCY_CONTACT}`
);
setupKeyboard();
enterNormal();
