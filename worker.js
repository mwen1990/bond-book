// ============================================================
//  Bond Athletic Auto-Booker — Cloudflare Worker
//  Deploy this to Cloudflare Workers (free tier)
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers so the PWA can call this from any device
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ── Routes ───────────────────────────────────────────────
    if (url.pathname === "/save-config" && request.method === "POST") {
      return handleSaveConfig(request, env, cors);
    }

    if (url.pathname === "/get-classes" && request.method === "GET") {
      return handleGetClasses(env, cors);
    }

    if (url.pathname === "/book" && request.method === "POST") {
      return handleBook(request, env, cors);
    }

    if (url.pathname === "/book-all" && request.method === "POST") {
      return handleBookAll(env, cors);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },

  // Cron trigger — runs on schedule for PC-less auto booking
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledBookings(env));
  },
};

// ─────────────────────────────────────────────────────────────
//  Save encrypted config (credentials + class list)
// ─────────────────────────────────────────────────────────────
async function handleSaveConfig(request, env, cors) {
  try {
    const body = await request.json();
    const { email, password, classes, pin } = body;

    if (!email || !password || !classes || !pin) {
      return json({ error: "Missing required fields" }, 400, cors);
    }

    // Encrypt with the user's PIN as key
    const encrypted = await encrypt(JSON.stringify({ email, password, classes }), pin + env.SALT);
    await env.KV.put("config", encrypted);

    return json({ ok: true, message: "Config saved!" }, 200, cors);
  } catch (e) {
    return json({ error: e.message }, 500, cors);
  }
}

// ─────────────────────────────────────────────────────────────
//  Get class list (without credentials)
// ─────────────────────────────────────────────────────────────
async function handleGetClasses(env, cors) {
  try {
    // We store a separate unencrypted class list for display
    const classList = await env.KV.get("classes_display");
    if (!classList) return json({ classes: [] }, 200, cors);
    return json({ classes: JSON.parse(classList) }, 200, cors);
  } catch (e) {
    return json({ error: e.message }, 500, cors);
  }
}

// ─────────────────────────────────────────────────────────────
//  Book a specific class
// ─────────────────────────────────────────────────────────────
async function handleBook(request, env, cors) {
  try {
    const { pin, classIndex } = await request.json();
    const config = await decryptConfig(env, pin);
    if (!config) return json({ error: "Wrong PIN or no config saved" }, 401, cors);

    const targetClass = config.classes[classIndex ?? 0];
    if (!targetClass) return json({ error: "Class not found" }, 404, cors);

    const result = await bookClass(config.email, config.password, targetClass, env);
    return json(result, 200, cors);
  } catch (e) {
    return json({ error: e.message }, 500, cors);
  }
}

// ─────────────────────────────────────────────────────────────
//  Book all classes due this week
// ─────────────────────────────────────────────────────────────
async function handleBookAll(env, cors) {
  // Called by cron or PC scheduler curl
  // Uses stored PIN from env secret
  try {
    const config = await decryptConfig(env, env.CRON_PIN);
    if (!config) return json({ error: "No config or wrong CRON_PIN" }, 401, cors);

    const now = new Date();
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];

    // Find classes that should be booked today
    // Logic: book next week's class ~30 mins after today's class ends
    const results = [];
    for (const cls of config.classes) {
      if (cls.day !== dayName) continue;

      // Check if current time is ~30 mins after class ends
      const classEndMinutes = timeToMinutes(cls.endTime);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const diff = nowMinutes - classEndMinutes;

      if (diff >= 25 && diff <= 90) {
        // Within the booking window
        const result = await bookClass(config.email, config.password, cls, env);
        results.push({ class: cls, result });
      }
    }

    return json({ booked: results }, 200, cors);
  } catch (e) {
    return json({ error: e.message }, 500, cors);
  }
}

// ─────────────────────────────────────────────────────────────
//  Core booking logic using PushPress HTTP API
//  (reverse-engineered from network requests)
// ─────────────────────────────────────────────────────────────
async function bookClass(email, password, cls, env) {
  const BASE = "https://bondathletic.pushpress.com";

  try {
    // ── 1. Login ──────────────────────────────────────────
    const loginRes = await fetch(`${BASE}/api/v3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!loginRes.ok) {
      // Try alternate login endpoint
      const loginRes2 = await fetch(`${BASE}/member/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!loginRes2.ok) {
        return { success: false, message: "Login failed — check your credentials" };
      }
    }

    // Extract auth token / session cookie
    const loginData = await loginRes.json().catch(() => ({}));
    const token = loginData.token || loginData.access_token || loginData.jwt;
    const setCookie = loginRes.headers.get("set-cookie") || "";

    const authHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...(setCookie ? { "Cookie": setCookie.split(";")[0] } : {}),
    };

    // ── 2. Get upcoming schedule ──────────────────────────
    // Find next occurrence of the target class
    const nextDate = getNextDate(cls.day);
    const dateStr = nextDate.toISOString().split("T")[0];

    const scheduleRes = await fetch(`${BASE}/api/v3/schedule?date=${dateStr}`, {
      headers: authHeaders,
    });

    let classId = null;

    if (scheduleRes.ok) {
      const schedule = await scheduleRes.json();
      // Find matching class by time
      const entries = schedule.data || schedule.classes || schedule || [];
      for (const entry of entries) {
        const entryTime = entry.start_time || entry.time || entry.scheduled_at || "";
        if (entryTime.includes(cls.startTime) || normalizeTime(entryTime) === normalizeTime(cls.startTime)) {
          classId = entry.id || entry.class_id || entry.event_id;
          break;
        }
      }
    }

    if (!classId) {
      return {
        success: false,
        message: `Could not find ${cls.day} ${cls.startTime} class on the schedule. The site layout may need investigation — try booking manually once and let us know.`,
      };
    }

    // ── 3. Reserve the class ──────────────────────────────
    const reserveRes = await fetch(`${BASE}/api/v3/reservations`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ class_id: classId }),
    });

    const reserveData = await reserveRes.json().catch(() => ({}));

    if (reserveRes.status === 409 || (reserveData.message || "").toLowerCase().includes("full")) {
      return { success: false, full: true, message: `${cls.day} ${cls.startTime} is full 😔` };
    }

    if (reserveRes.ok) {
      return { success: true, message: `✅ Booked! See you ${cls.day} at ${cls.startTime}` };
    }

    return {
      success: false,
      message: `Booking failed: ${reserveData.message || reserveRes.status}`,
    };

  } catch (e) {
    return { success: false, message: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────────────────────
//  Scheduled cron handler
// ─────────────────────────────────────────────────────────────
async function runScheduledBookings(env) {
  try {
    const config = await decryptConfig(env, env.CRON_PIN);
    if (!config) return;

    const now = new Date();
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getDay()];

    for (const cls of config.classes) {
      if (cls.day !== dayName) continue;
      const classEndMinutes = timeToMinutes(cls.endTime);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const diff = nowMinutes - classEndMinutes;
      if (diff >= 25 && diff <= 90) {
        await bookClass(config.email, config.password, cls, env);
      }
    }
  } catch (e) {
    console.error("Scheduled booking error:", e);
  }
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
async function decryptConfig(env, pin) {
  try {
    const encrypted = await env.KV.get("config");
    if (!encrypted) return null;
    const decrypted = await decrypt(encrypted, pin + env.SALT);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

function getNextDate(dayName) {
  const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const today = new Date();
  const targetDay = days.indexOf(dayName);
  let daysAhead = targetDay - today.getDay();
  if (daysAhead <= 0) daysAhead += 7;
  const next = new Date(today);
  next.setDate(today.getDate() + daysAhead);
  return next;
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return 0;
  let hours = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const period = (match[3] || "").toUpperCase();
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return hours * 60 + mins;
}

function normalizeTime(t) {
  return (t || "").toLowerCase().replace(/\s/g, "");
}

async function encrypt(text, key) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(key.padEnd(32).slice(0, 32)), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyMaterial, enc.encode(text));
  const combined = new Uint8Array([...iv, ...new Uint8Array(encrypted)]);
  return btoa(String.fromCharCode(...combined));
}

async function decrypt(b64, key) {
  const enc = new TextEncoder();
  const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(key.padEnd(32).slice(0, 32)), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyMaterial, data);
  return new TextDecoder().decode(decrypted);
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
