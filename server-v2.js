const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ── CONFIG
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const CANCEL_WEBHOOK_URL = process.env.CANCEL_WEBHOOK_URL;
const SEARCH_WEBHOOK_URL = process.env.SEARCH_WEBHOOK_URL;
const CLINIC_OWNER_PHONE = process.env.CLINIC_OWNER_PHONE || "";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

// ── Clinic working hours in UTC (Gulf 9AM-6PM = UTC 6AM-3PM)
const WORKING_HOURS_START_UTC = 6;  // 9AM Gulf
const WORKING_HOURS_END_UTC = 15;   // 6PM Gulf
const SLOT_DURATION_MIN = 30;

// ── Expiry times
const CONV_EXPIRY_SECONDS = 7 * 24 * 60 * 60;       // 7 days for conversation history
const PATIENT_EXPIRY_NORMAL = 7 * 24 * 60 * 60;      // 7 days for new patients
const PATIENT_EXPIRY_LOYAL = 90 * 24 * 60 * 60;      // 90 days for loyal patients (3+ bookings)
const LOYAL_BOOKING_THRESHOLD = 3;

// ── Load Sara's base prompt from external file (universal rules, no clinic data)
const SARA_BASE_PROMPT = fs.readFileSync("sara_prompt_base.txt", "utf8");
console.log("Sara base prompt loaded successfully.");

// ── AWS Bedrock client
const bedrockClient = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// ══════════════════════════════════════════════════════════════
// ── NEON POSTGRESQL — CLIENT DATABASE (Step 3)
// ══════════════════════════════════════════════════════════════

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
}) : null;

// ── Client cache (loaded from DB on startup, refreshed every 30 minutes)
let clientCache = new Map();

async function loadClientsFromDB() {
  if (!pool) {
    console.log("DATABASE_URL not set — skipping client cache load");
    return;
  }
  try {
    const result = await pool.query("SELECT * FROM clinics WHERE active = TRUE");
    const newCache = new Map();
    for (const row of result.rows) {
      newCache.set(row.phone_number_id, row);
    }
    clientCache = newCache;
    console.log(`Client cache loaded: ${clientCache.size} active clinic(s)`);
  } catch (err) {
    console.error("Failed to load client cache:", err.message);
  }
}

function getClientByPhoneNumberId(phoneNumberId) {
  return clientCache.get(phoneNumberId) || null;
}

// Load clients on startup + refresh every 30 minutes
loadClientsFromDB();
setInterval(loadClientsFromDB, 30 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
// ── UPSTASH REDIS HELPERS
// ══════════════════════════════════════════════════════════════

async function redisCommand(command) {
  try {
    const response = await axios.post(
      `${UPSTASH_REDIS_REST_URL}`,
      command,
      {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        timeout: 5000,
      }
    );
    return response.data?.result;
  } catch (err) {
    console.error("Redis error:", err.message);
    return null;
  }
}

async function redisGet(key) {
  return await redisCommand(["GET", key]);
}

async function redisSet(key, value, expirySeconds) {
  return await redisCommand(["SET", key, value, "EX", String(expirySeconds)]);
}

async function redisDel(key) {
  return await redisCommand(["DEL", key]);
}

// ── Conversation history (Redis-backed)
const MAX_HISTORY = 20;

async function getHistory(phone) {
  const data = await redisGet(`conv:${phone}`);
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      return [];
    }
  }
  return [];
}

async function addToHistory(phone, role, content) {
  const history = await getHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  await redisSet(`conv:${phone}`, JSON.stringify(history), CONV_EXPIRY_SECONDS);
}

// ── Patient profiles (Redis-backed)
async function getPatientProfile(phone) {
  const data = await redisGet(`patient:${phone}`);
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function savePatientProfile(phone, name, service) {
  const existing = await getPatientProfile(phone);
  const bookings = existing ? (existing.bookings || 0) + 1 : 1;
  const profile = {
    name: name || (existing && existing.name) || "",
    phone: phone,
    bookings: bookings,
    last_service: service || (existing && existing.last_service) || "",
    last_visit: new Date().toISOString(),
  };

  const expiry = bookings >= LOYAL_BOOKING_THRESHOLD ? PATIENT_EXPIRY_LOYAL : PATIENT_EXPIRY_NORMAL;
  await redisSet(`patient:${phone}`, JSON.stringify(profile), expiry);
  console.log(`Patient profile saved: ${name}, bookings: ${bookings}, expiry: ${expiry / 86400} days`);
  return profile;
}

// ── Last suggested time (Redis-backed, short expiry)
async function getLastSuggested(phone) {
  const data = await redisGet(`suggested:${phone}`);
  return data ? parseInt(data) : null;
}

async function setLastSuggested(phone, utcMs) {
  // 10 minute expiry — race condition window
  await redisSet(`suggested:${phone}`, String(utcMs), 600);
}

async function clearLastSuggested(phone) {
  await redisDel(`suggested:${phone}`);
}

// ── RESET command for testing
async function resetPatientData(phone) {
  await redisDel(`conv:${phone}`);
  await redisDel(`patient:${phone}`);
  await redisDel(`suggested:${phone}`);
  console.log(`RESET: Cleared all data for ${phone}`);
}

// ── Convert UTC datetime string to readable Arabic (Gulf time UTC+3)
function formatTimeArabic(isoString) {
  try {
    const cleaned = String(isoString).trim();
    const date = new Date(cleaned);

    if (isNaN(date.getTime())) {
      return isoString;
    }

    // Convert UTC to Gulf time (UTC+3)
    const gulfDate = new Date(date.getTime() + 3 * 60 * 60 * 1000);

    const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    const dayName = days[gulfDate.getUTCDay()];

    let hours = gulfDate.getUTCHours();
    const minutes = gulfDate.getUTCMinutes();
    const period = hours >= 12 ? "مساءً" : "صباحاً";
    if (hours > 12) hours -= 12;
    if (hours === 0) hours = 12;

    // Include minutes only if not zero (e.g., "2:30" but not "2:00")
    const timeStr = minutes > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : `${hours}`;

    return `${dayName} الساعة ${timeStr} ${period}`;
  } catch (err) {
    return isoString;
  }
}

// ── Parse [BOOKING:...] tag from Sara's response
function extractBookingTag(text) {
  const match = text.match(/\[BOOKING:([^\]]+)\]/);
  if (!match) return null;

  const params = {};
  match[1].split(",").forEach(pair => {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      params[key.trim()] = valueParts.join("=").trim();
    }
  });

  return params;
}

// ── Parse [CANCEL:...] tag from Sara's response
function extractCancelTag(text) {
  const match = text.match(/\[CANCEL:([^\]]+)\]/);
  if (!match) return null;

  const params = {};
  match[1].split(",").forEach(pair => {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      params[key.trim()] = valueParts.join("=").trim();
    }
  });

  return params;
}

// ── Parse [RESCHEDULE:...] tag from Sara's response
function extractRescheduleTag(text) {
  const match = text.match(/\[RESCHEDULE:([^\]]+)\]/);
  if (!match) return null;

  const params = {};
  match[1].split(",").forEach(pair => {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      params[key.trim()] = valueParts.join("=").trim();
    }
  });

  return params;
}

// ── Parse [CHECK_AVAILABILITY:...] tag from Sara's response
function extractCheckAvailabilityTag(text) {
  const match = text.match(/\[CHECK_AVAILABILITY:([^\]]+)\]/);
  if (!match) return null;

  const params = {};
  match[1].split(",").forEach(pair => {
    const [key, ...valueParts] = pair.split("=");
    if (key && valueParts.length > 0) {
      params[key.trim()] = valueParts.join("=").trim();
    }
  });

  return params;
}

// ── Strip all hidden tags from message text
function stripAllTags(text) {
  return text
    .replace(/\[BOOKING:[^\]]+\]/g, "")
    .replace(/\[CANCEL:[^\]]+\]/g, "")
    .replace(/\[RESCHEDULE:[^\]]+\]/g, "")
    .replace(/\[CHECK_AVAILABILITY:[^\]]+\]/g, "")
    .trim();
}

// ── Send WhatsApp message
async function sendWhatsApp(to, message) {
  await axios.post(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ── Send clinic owner notification
async function notifyClinicOwner(type, details) {
  if (!CLINIC_OWNER_PHONE) {
    console.log("No CLINIC_OWNER_PHONE set, skipping notification");
    return;
  }

  let message = "";

  if (type === "new_booking") {
    message = `موعد جديد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}\nالخدمة: ${details.service}\nالوقت: ${details.time}`;
  } else if (type === "cancelled") {
    message = `تم إلغاء موعد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}`;
  } else if (type === "rescheduled") {
    message = `تم تغيير موعد:\nالاسم: ${details.name}\nالهاتف: ${details.phone}\nالخدمة: ${details.service}\nمن: ${details.old_time}\nإلى: ${details.new_time}`;
  }

  if (!message) return;

  try {
    await sendWhatsApp(CLINIC_OWNER_PHONE, message);
    console.log(`Clinic owner notified: ${type}`);
  } catch (err) {
    console.error("Clinic notification error:", err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ── ALTERNATIVE TIME SUGGESTIONS (Phase 3)
// ══════════════════════════════════════════════════════════════

// ── Call Make.com search-availability webhook to get busy times for a day
async function queryDayAvailability(searchStart, searchEnd) {
  if (!SEARCH_WEBHOOK_URL) {
    console.error("SEARCH_WEBHOOK_URL not set");
    return [];
  }

  const payload = {
    type: "search",
    search_date_start: searchStart,
    search_date_end: searchEnd,
  };

  console.log("Querying availability:", payload);

  try {
    const response = await axios.post(SEARCH_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const busyTimesStr = response.data?.busy_times || "";
    if (!busyTimesStr) {
      console.log("No busy times — entire window is free");
      return [];
    }

    // Parse "start~end|start~end|..." format
    const busyPeriods = [];
    const entries = busyTimesStr.split("|");
    for (const entry of entries) {
      const parts = entry.split("~");
      if (parts.length === 2) {
        const start = new Date(parts[0].trim());
        const end = new Date(parts[1].trim());
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          busyPeriods.push({ start, end });
        }
      }
    }

    console.log(`Found ${busyPeriods.length} busy periods`);
    return busyPeriods;
  } catch (err) {
    console.error("Search availability error:", err.message);
    return [];
  }
}

// ── Calculate all free 30-min slots in a window given busy periods
function calculateFreeSlots(busyPeriods, windowStartUTC, windowEndUTC) {
  const slots = [];
  const slotMs = SLOT_DURATION_MIN * 60 * 1000;

  // Generate every 30-min slot in the window
  let cursor = new Date(windowStartUTC).getTime();
  const endMs = new Date(windowEndUTC).getTime();

  while (cursor + slotMs <= endMs) {
    const slotStart = cursor;
    const slotEnd = cursor + slotMs;

    // Check if this slot overlaps with any busy period
    let isBusy = false;
    for (const busy of busyPeriods) {
      const busyStart = busy.start.getTime();
      const busyEnd = busy.end.getTime();
      // Overlap: slot starts before busy ends AND slot ends after busy starts
      if (slotStart < busyEnd && slotEnd > busyStart) {
        isBusy = true;
        break;
      }
    }

    if (!isBusy) {
      slots.push(new Date(slotStart));
    }

    cursor += slotMs;
  }

  return slots;
}

// ── Get working hours window (UTC) for a given date
function getWorkingWindow(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const start = new Date(Date.UTC(year, month, day, WORKING_HOURS_START_UTC, 0, 0));
  const end = new Date(Date.UTC(year, month, day, WORKING_HOURS_END_UTC, 0, 0));

  return { start, end };
}

// ── Get next working day (skip Sunday — clinic is Mon-Sat)
function getNextWorkingDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);

  // Sunday = 0 in UTC. Gulf Sunday = UTC could be Sat night or Sun.
  // Gulf calendar: Mon-Sat open, Sun closed.
  // We work with Gulf day: add 3h to UTC to get Gulf day.
  const gulfDate = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  if (gulfDate.getUTCDay() === 0) {
    // Gulf Sunday — skip to Monday
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d;
}

// ── Pick the best slot from a list: prefer forward from requested, then backward
function pickClosestSlot(freeSlots, requestedTime) {
  if (freeSlots.length === 0) return null;

  const reqMs = new Date(requestedTime).getTime();

  // Separate into forward (after requested) and backward (before requested)
  const forward = freeSlots.filter(s => s.getTime() >= reqMs);
  const backward = freeSlots.filter(s => s.getTime() < reqMs);

  // Prefer forward first, then backward — both sorted by proximity
  forward.sort((a, b) => a.getTime() - b.getTime());
  backward.sort((a, b) => b.getTime() - a.getTime());

  if (forward.length > 0) return forward[0];
  if (backward.length > 0) return backward[0];
  return null;
}

// ── THE WATERFALL: Find alternative time (5-step search)
async function findAlternative(utcStart) {
  try {
    const requested = new Date(utcStart);
    if (isNaN(requested.getTime())) {
      console.error("findAlternative: invalid utcStart:", utcStart);
      return null;
    }

    console.log(`WATERFALL: Starting search for alternative to ${utcStart}`);

    // ── DAY 1 (same day as requested) ──
    const day1Window = getWorkingWindow(requested);
    const day1Start = day1Window.start.toISOString().replace(".000Z", "+00:00");
    const day1End = day1Window.end.toISOString().replace(".000Z", "+00:00");

    const day1Busy = await queryDayAvailability(day1Start, day1End);
    const day1FreeAll = calculateFreeSlots(day1Busy, day1Window.start, day1Window.end);

    // Step 1: ±2h from requested, clamped to working hours
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const range1Start = new Date(Math.max(requested.getTime() - twoHoursMs, day1Window.start.getTime()));
    const range1End = new Date(Math.min(requested.getTime() + twoHoursMs + SLOT_DURATION_MIN * 60 * 1000, day1Window.end.getTime()));

    const step1Slots = day1FreeAll.filter(s =>
      s.getTime() >= range1Start.getTime() && s.getTime() < range1End.getTime()
    );

    const step1Pick = pickClosestSlot(step1Slots, requested);
    if (step1Pick) {
      console.log(`WATERFALL Step 1: Found ${step1Pick.toISOString()} (±2h same day)`);
      return { utc: step1Pick, sameDay: true };
    }

    // Step 2: Any free slot on Day 1
    const step2Pick = pickClosestSlot(day1FreeAll, requested);
    if (step2Pick) {
      console.log(`WATERFALL Step 2: Found ${step2Pick.toISOString()} (same day, any time)`);
      return { utc: step2Pick, sameDay: true };
    }

    // ── DAY 2 (next working day) ──
    const day2Date = getNextWorkingDay(requested);
    const day2Window = getWorkingWindow(day2Date);
    const day2Start = day2Window.start.toISOString().replace(".000Z", "+00:00");
    const day2End = day2Window.end.toISOString().replace(".000Z", "+00:00");

    const day2Busy = await queryDayAvailability(day2Start, day2End);
    const day2FreeAll = calculateFreeSlots(day2Busy, day2Window.start, day2Window.end);

    // Step 3: Exact same time on Day 2
    // Calculate the same Gulf hour on Day 2
    const requestedHourUTC = requested.getUTCHours();
    const requestedMinUTC = requested.getUTCMinutes();
    const day2SameTime = new Date(Date.UTC(
      day2Window.start.getUTCFullYear(),
      day2Window.start.getUTCMonth(),
      day2Window.start.getUTCDate(),
      requestedHourUTC,
      requestedMinUTC,
      0
    ));

    // Check if exact time is in the free list
    const step3Match = day2FreeAll.find(s => s.getTime() === day2SameTime.getTime());
    if (step3Match) {
      console.log(`WATERFALL Step 3: Found ${step3Match.toISOString()} (exact time, next day)`);
      return { utc: step3Match, sameDay: false };
    }

    // Step 4: ±2h on Day 2
    const range4Start = new Date(Math.max(day2SameTime.getTime() - twoHoursMs, day2Window.start.getTime()));
    const range4End = new Date(Math.min(day2SameTime.getTime() + twoHoursMs + SLOT_DURATION_MIN * 60 * 1000, day2Window.end.getTime()));

    const step4Slots = day2FreeAll.filter(s =>
      s.getTime() >= range4Start.getTime() && s.getTime() < range4End.getTime()
    );

    const step4Pick = pickClosestSlot(step4Slots, day2SameTime);
    if (step4Pick) {
      console.log(`WATERFALL Step 4: Found ${step4Pick.toISOString()} (±2h next day)`);
      return { utc: step4Pick, sameDay: false };
    }

    // Step 5: Any free slot on Day 2
    const step5Pick = pickClosestSlot(day2FreeAll, day2SameTime);
    if (step5Pick) {
      console.log(`WATERFALL Step 5: Found ${step5Pick.toISOString()} (next day, any time)`);
      return { utc: step5Pick, sameDay: false };
    }

    // Step 6: Both days fully booked
    console.log("WATERFALL: No alternative found in 2 days");
    return null;

  } catch (err) {
    console.error("findAlternative error:", err.message);
    return null;
  }
}

// ── Build SYSTEM_RESULT for busy with alternative
// ── Check if this is a race condition (booking failed on a previously suggested time)
async function isRaceCondition(userPhone, failedUtcStart) {
  const suggested = await getLastSuggested(userPhone);
  if (!suggested) return false;

  const failedMs = new Date(failedUtcStart).getTime();
  const diffMs = Math.abs(suggested - failedMs);

  // Clear the flag regardless
  await clearLastSuggested(userPhone);

  // If the failed time is within 5 minutes of what we suggested, it's a race condition
  return diffMs < 5 * 60 * 1000;
}

// ── Resolve day name/word to a UTC date
function resolveDay(dayStr) {
  const now = new Date();
  // Current Gulf date (UTC+3)
  const gulfNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const gulfToday = new Date(Date.UTC(gulfNow.getUTCFullYear(), gulfNow.getUTCMonth(), gulfNow.getUTCDate()));

  const lower = dayStr.toLowerCase().trim();

  // Today
  if (["today", "اليوم", "هلأ"].includes(lower)) {
    return gulfToday;
  }

  // Tomorrow
  if (["tomorrow", "غداً", "غدا", "بكرة", "بكره", "bokra"].includes(lower)) {
    const d = new Date(gulfToday);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }

  // Day after tomorrow
  if (["day_after_tomorrow", "بعد غد", "بعد بكرة", "بعد بكره"].includes(lower)) {
    const d = new Date(gulfToday);
    d.setUTCDate(d.getUTCDate() + 2);
    return d;
  }

  // Day names → next occurrence (Gulf week: Sun=0, Mon=1, ..., Sat=6)
  const dayMap = {
    "sunday": 0, "الأحد": 0, "الاحد": 0,
    "monday": 1, "الاثنين": 1, "الإثنين": 1,
    "tuesday": 2, "الثلاثاء": 2,
    "wednesday": 3, "الأربعاء": 3, "الاربعاء": 3,
    "thursday": 4, "الخميس": 4,
    "friday": 5, "الجمعة": 5,
    "saturday": 6, "السبت": 6,
  };

  const targetDay = dayMap[lower];
  if (targetDay !== undefined) {
    const currentDay = gulfToday.getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7; // Next week if today or past
    const d = new Date(gulfToday);
    d.setUTCDate(d.getUTCDate() + daysAhead);
    return d;
  }

  // Fallback: try tomorrow
  console.log(`resolveDay: unknown day "${dayStr}", defaulting to tomorrow`);
  const d = new Date(gulfToday);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// ── Select 3-4 well-spread slots across morning, midday, afternoon
function selectSpreadSlots(freeSlots) {
  if (freeSlots.length === 0) return [];
  if (freeSlots.length <= 4) return freeSlots;

  // Split into time windows (Gulf time = UTC + 3h)
  // Morning: 9AM-12PM Gulf = 6:00-9:00 UTC
  // Midday: 12PM-3PM Gulf = 9:00-12:00 UTC
  // Afternoon: 3PM-6PM Gulf = 12:00-15:00 UTC
  const morning = freeSlots.filter(s => s.getUTCHours() >= 6 && s.getUTCHours() < 9);
  const midday = freeSlots.filter(s => s.getUTCHours() >= 9 && s.getUTCHours() < 12);
  const afternoon = freeSlots.filter(s => s.getUTCHours() >= 12 && s.getUTCHours() < 15);

  const picks = [];

  // Pick 1 from each window if available (pick middle of each window for variety)
  if (morning.length > 0) picks.push(morning[Math.floor(morning.length / 2)]);
  if (midday.length > 0) picks.push(midday[Math.floor(midday.length / 2)]);
  if (afternoon.length > 0) picks.push(afternoon[Math.floor(afternoon.length / 2)]);

  // If we have fewer than 3, fill from the largest window
  if (picks.length < 3) {
    const all = [...morning, ...midday, ...afternoon];
    for (const slot of all) {
      if (picks.length >= 4) break;
      if (!picks.find(p => p.getTime() === slot.getTime())) {
        picks.push(slot);
      }
    }
  }

  // Sort chronologically
  picks.sort((a, b) => a.getTime() - b.getTime());
  return picks.slice(0, 4);
}

// ── Check availability for a given day — returns formatted slot list
async function checkDayAvailability(dayStr) {
  try {
    const targetDate = resolveDay(dayStr);
    const window = getWorkingWindow(targetDate);

    // Check if target day is Sunday (Gulf) — clinic closed
    const gulfDate = new Date(targetDate.getTime() + 3 * 60 * 60 * 1000);
    if (gulfDate.getUTCDay() === 0) {
      return { status: "closed", day: dayStr };
    }

    const searchStart = window.start.toISOString().replace(".000Z", "+00:00");
    const searchEnd = window.end.toISOString().replace(".000Z", "+00:00");

    const busyPeriods = await queryDayAvailability(searchStart, searchEnd);
    const freeSlots = calculateFreeSlots(busyPeriods, window.start, window.end);

    if (freeSlots.length === 0) {
      return { status: "fully_booked", day: dayStr };
    }

    const selected = selectSpreadSlots(freeSlots);
    const formatted = selected.map(s => formatTimeArabic(s.toISOString()));

    return { status: "availability", slots: formatted, day: dayStr, total_free: freeSlots.length };
  } catch (err) {
    console.error("checkDayAvailability error:", err.message);
    return { status: "error" };
  }
}

// ══════════════════════════════════════════════════════════════
// ── END Phase 3 functions
// ══════════════════════════════════════════════════════════════

// ── Call Make.com BOOKING webhook and WAIT for JSON response
async function triggerBooking(bookingParams, patientPhone) {
  if (!MAKE_WEBHOOK_URL) {
    console.error("MAKE_WEBHOOK_URL not set");
    return { status: "error" };
  }

  const payload = {
    name: bookingParams.name || "",
    phone: bookingParams.phone || patientPhone,
    requested_time: bookingParams.time || "",
    service: bookingParams.service || "free consultation",
    patient_phone: patientPhone,
    clinic_owner_phone: CLINIC_OWNER_PHONE,
  };

  console.log("Triggering BOOKING webhook:", payload);

  try {
    const response = await axios.post(MAKE_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    console.log("Booking response:", response.data);
    return response.data;
  } catch (err) {
    console.error("Booking webhook error:", err.message);
    return { status: "error" };
  }
}

// ── Call Make.com CANCEL webhook and WAIT for JSON response
async function triggerCancel(cancelParams, patientPhone) {
  if (!CANCEL_WEBHOOK_URL) {
    console.error("CANCEL_WEBHOOK_URL not set");
    return { status: "error" };
  }

  const payload = {
    type: "cancel",
    name: cancelParams.name || "",
    phone: cancelParams.phone || patientPhone,
    current_utc: new Date().toISOString().replace(".000Z", "+00:00"),
  };

  console.log("Triggering CANCEL webhook:", payload);

  try {
    const response = await axios.post(CANCEL_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    console.log("Cancel response:", response.data);
    return response.data;
  } catch (err) {
    console.error("Cancel webhook error:", err.message);
    return { status: "error" };
  }
}

// ── Handle RESCHEDULE: cancel old → book new → if fail → re-book old
async function triggerReschedule(rescheduleParams, patientPhone) {

  // Step 1: Cancel the old appointment first
  console.log("RESCHEDULE Step 1: Cancelling old appointment...");
  const cancelParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
  };
  const cancelResult = await triggerCancel(cancelParams, patientPhone);

  // If no appointment found, stop
  if (cancelResult.status === "not_found") {
    console.log("RESCHEDULE failed: no existing appointment found.");
    return { status: "not_found" };
  }

  // If cancel errored, stop
  if (cancelResult.status === "error") {
    console.log("RESCHEDULE failed: cancel error.");
    return { status: "error" };
  }

  // Save old event details for potential re-booking
  const oldTimeRaw = cancelResult.old_time || "";
  const oldService = cancelResult.old_service || "appointment";
  const oldTimeArabic = formatTimeArabic(oldTimeRaw);
  console.log(`Old appointment saved: raw=${oldTimeRaw}, arabic=${oldTimeArabic}, service=${oldService}`);

  // Step 2: Book the new time
  console.log("RESCHEDULE Step 2: Booking new time...");
  const bookingParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
    time: rescheduleParams.new_time || "",
    service: rescheduleParams.service || oldService,
  };
  const bookResult = await triggerBooking(bookingParams, patientPhone);

  // If new time booked successfully, done!
  if (bookResult.status === "booked") {
    console.log("RESCHEDULE complete: new time booked successfully.");
    return {
      status: "rescheduled",
      old_time: oldTimeArabic,
      new_time: rescheduleParams.new_time,
      service: rescheduleParams.service || oldService,
    };
  }

  // Step 3: New time failed — re-book the old time to restore it (SILENT — no notification)
  console.log(`RESCHEDULE Step 3: New time failed (${bookResult.status}). Re-booking old time...`);

  const rebookParams = {
    name: rescheduleParams.name || "",
    phone: rescheduleParams.phone || patientPhone,
    time: oldTimeRaw,
    service: rescheduleParams.service || oldService,
  };
  const rebookResult = await triggerBooking(rebookParams, patientPhone);
  console.log(`Re-book old time result: ${rebookResult.status}`);

  // Run waterfall to find alternative for the failed reschedule
  if (bookResult.status === "busy" && bookResult.utc_start) {
    const alternative = await findAlternative(bookResult.utc_start);
    if (alternative) {
      const altArabic = formatTimeArabic(alternative.utc.toISOString());
      return {
        status: "reschedule_failed_busy",
        alternative: altArabic,
        same_day: alternative.sameDay,
        rebookSilent: true,
      };
    }
    return { status: "reschedule_failed_busy", alternative: null, rebookSilent: true };
  }

  if (bookResult.status === "outside_hours") {
    return { status: "reschedule_failed_outside_hours", rebookSilent: true };
  }

  return { status: "error" };
}

// ── Call Claude via AWS Bedrock
async function callClaude(userPhone, userMessage) {
  await addToHistory(userPhone, "user", userMessage);

  const history = await getHistory(userPhone);

  // Build dynamic prompt: base rules + clinic data from DB + patient info
  let dynamicPrompt = SARA_BASE_PROMPT;

  // Inject clinic data from database
  const clinicData = getClientByPhoneNumberId(PHONE_NUMBER_ID);
  if (clinicData) {
    dynamicPrompt += `\n\nمعلومات العيادة:`;
    dynamicPrompt += `\n- الاسم: ${clinicData.clinic_name_ar}`;
    if (clinicData.location) dynamicPrompt += `\n- الموقع: ${clinicData.location}`;
    if (clinicData.doctors) dynamicPrompt += `\n- الأطباء: ${clinicData.doctors}`;
    if (clinicData.knowledge_base) dynamicPrompt += `\n${clinicData.knowledge_base}`;
    if (clinicData.languages) {
      const langMap = { ar: "العربية", en: "الإنجليزية", fr: "الفرنسية" };
      const langNames = clinicData.languages.split(",").map(l => langMap[l.trim()] || l.trim()).join(" و");
      dynamicPrompt += `\n- اللغات: ${langNames} فقط. أي لغة أخرى → رد بالعربية.`;
    }

    // Priority override — injected LAST, overrides everything
    if (clinicData.priority_override) {
      dynamicPrompt += `\n\nتحديثات مهمة (لها الأولوية المطلقة على أي معلومات أخرى):\n${clinicData.priority_override}`;
    }
  }

  // Inject patient's WhatsApp number
  dynamicPrompt += `\n\nرقم واتساب المريض الحالي: ${userPhone}`;

  // Check if we know this patient
  const profile = await getPatientProfile(userPhone);
  if (profile && profile.name) {
    dynamicPrompt += `\nهذا المريض معروف. اسمه: ${profile.name}. عدد حجوزاته السابقة: ${profile.bookings}. آخر خدمة: ${profile.last_service}.`;
    dynamicPrompt += `\nرحّب به باسمه بشكل طبيعي ودافئ. لا تسأله عن اسمه أو رقمه --- أنت تعرفهم.`;
  }

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: dynamicPrompt }],
    messages: history.map(msg => ({
      role: msg.role,
      content: [{ text: msg.content }],
    })),
    inferenceConfig: {
      maxTokens: 500,
      temperature: 0.7,
    },
  });

  const response = await bedrockClient.send(command);
  const assistantMessage = response.output.message.content[0].text;

  await addToHistory(userPhone, "assistant", assistantMessage);

  return assistantMessage;
}

// ── STEP 1: Meta webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── STEP 2: Receive WhatsApp message (POST)
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return;

    const userPhone = message.from;

    // ── RESET command: clear all data for testing (clears sender's own data only)
    if (message.type === "text" && message.text.body.trim().toUpperCase() === "RESET") {
      await resetPatientData(userPhone);
      await sendWhatsApp(userPhone, "تم مسح جميع البيانات. المحادثة تبدأ من جديد.");
      console.log(`RESET triggered by ${userPhone}`);
      return;
    }

    // ── Handle reactions: ignore completely (no reply needed)
    if (message.type === "reaction") return;

    // ── Handle voice/audio messages: tell Sara, let her respond naturally
    if (message.type === "audio") {
      console.log(`Voice message from ${userPhone}`);
      const saraResponse = await callClaude(userPhone, "[المريض أرسل رسالة صوتية. لا تستطيع سماعها. اطلب منه بلطف أن يكتب رسالته.]");
      const cleanResponse = stripAllTags(saraResponse);
      if (cleanResponse) {
        await sendWhatsApp(userPhone, cleanResponse);
        console.log(`Replied to voice from ${userPhone}: ${cleanResponse}`);
      }
      return;
    }

    // ── Handle image/video/document/sticker/location/contacts: hardcoded reply
    if (["image", "video", "document", "sticker", "location", "contacts"].includes(message.type)) {
      console.log(`Non-text message (${message.type}) from ${userPhone}`);
      await sendWhatsApp(userPhone, "عذراً، أقدر أساعدك بالرسائل النصية فقط حالياً. ممكن تكتب لي رسالتك؟");
      return;
    }

    // ── Only process text messages from here
    if (message.type !== "text") return;

    const userText = message.text.body;

    console.log(`Incoming from ${userPhone}: ${userText}`);

    // ── First call: Sara responds to the patient's message
    const saraResponse = await callClaude(userPhone, userText);
    console.log(`Sara raw response: ${saraResponse}`);

    // ── Check which tag Sara included
    const bookingParams = extractBookingTag(saraResponse);
    const cancelParams = extractCancelTag(saraResponse);
    const rescheduleParams = extractRescheduleTag(saraResponse);
    const checkAvailParams = extractCheckAvailabilityTag(saraResponse);

    if (bookingParams) {
      // ── BOOKING FLOW
      console.log("Booking detected:", bookingParams);
      const makeResult = await triggerBooking(bookingParams, userPhone);
      console.log("Calendar result:", makeResult);

      let resultToInject;

      if (makeResult.status === "busy") {
        // ── PHASE 3: Run waterfall search for alternative
        const retry = await isRaceCondition(userPhone, makeResult.utc_start || "");

        const alternative = await findAlternative(makeResult.utc_start || "");
        if (alternative) {
          const altArabic = formatTimeArabic(alternative.utc.toISOString());
          // Store suggestion for race condition detection on next attempt
          await setLastSuggested(userPhone, alternative.utc.getTime());
          resultToInject = {
            status: "busy",
            alternative: altArabic,
            same_day: alternative.sameDay,
            retry: retry,
          };
        } else {
          resultToInject = {
            status: "busy",
            alternative: null,
            same_day: false,
            retry: retry,
          };
        }
      } else {
        // booked, outside_hours, error — pass through as-is
        resultToInject = makeResult;
        // Clear any pending suggestion if booking succeeded
        if (makeResult.status === "booked") {
          await clearLastSuggested(userPhone);
        }
      }

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(resultToInject)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful bookings only
      if (makeResult.status === "booked") {
        // Save/update patient profile
        await savePatientProfile(userPhone, bookingParams.name, bookingParams.service);

        await notifyClinicOwner("new_booking", {
          name: bookingParams.name,
          phone: bookingParams.phone || userPhone,
          service: bookingParams.service || "free consultation",
          time: bookingParams.time,
        });
      }

    } else if (cancelParams) {
      // ── CANCEL FLOW (unchanged)
      console.log("Cancel detected:", cancelParams);
      const cancelResult = await triggerCancel(cancelParams, userPhone);
      console.log("Cancel result:", cancelResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(cancelResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful cancellations only
      if (cancelResult.status === "cancelled") {
        await notifyClinicOwner("cancelled", {
          name: cancelParams.name,
          phone: cancelParams.phone || userPhone,
        });
      }

    } else if (rescheduleParams) {
      // ── RESCHEDULE FLOW (with alternatives for failed reschedules)
      console.log("Reschedule detected:", rescheduleParams);
      const rescheduleResult = await triggerReschedule(rescheduleParams, userPhone);
      console.log("Reschedule result:", rescheduleResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(rescheduleResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

      // Notify clinic owner for successful reschedules only — NOT for failed re-books
      if (rescheduleResult.status === "rescheduled") {
        await notifyClinicOwner("rescheduled", {
          name: rescheduleParams.name,
          phone: rescheduleParams.phone || userPhone,
          service: rescheduleParams.service || rescheduleResult.service,
          old_time: rescheduleResult.old_time,
          new_time: rescheduleParams.new_time,
        });
      }
      // Failed reschedule (re-book) → NO notification. Nothing changed for the clinic.

    } else if (checkAvailParams) {
      // ── CHECK AVAILABILITY FLOW
      console.log("Availability check detected:", checkAvailParams);
      const availResult = await checkDayAvailability(checkAvailParams.day || "tomorrow");
      console.log("Availability result:", availResult);

      const resultMessage = `[SYSTEM_RESULT: ${JSON.stringify(availResult)}]`;
      const finalResponse = await callClaude(userPhone, resultMessage);
      const cleanFinal = stripAllTags(finalResponse);
      if (!cleanFinal) return;

      await sendWhatsApp(userPhone, cleanFinal);
      console.log(`Replied to ${userPhone}: ${cleanFinal}`);

    } else {
      // ── NORMAL FLOW: no tags, send response directly
      const cleanResponse = stripAllTags(saraResponse);
      if (!cleanResponse) return;

      await sendWhatsApp(userPhone, cleanResponse);
      console.log(`Replied to ${userPhone}: ${cleanResponse}`);
    }

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sara v2 running on port ${PORT}`));
