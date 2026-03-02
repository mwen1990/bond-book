# Bond Book — Full Setup Guide

## What you're setting up
- **Cloudflare Worker** — the backend that logs into Bond Athletic and books your class
- **GitHub Pages** — hosts the web app (free)
- **Home screen icon** — tap it on your phone to book instantly
- **Windows Task Scheduler** — auto-books ~30 mins after each class ends (optional)

Estimated time: **20–30 minutes**, one-time setup.

---

## Part 1 — Deploy the Cloudflare Worker

### 1.1 Create a free Cloudflare account
Go to https://cloudflare.com and sign up (free).

### 1.2 Install Node.js and Wrangler
1. Download Node.js from https://nodejs.org (LTS version)
2. Open Command Prompt and run:
```
npm install -g wrangler
wrangler login
```
This opens a browser to log you into Cloudflare.

### 1.3 Create a KV namespace
In Command Prompt:
```
wrangler kv:namespace create "KV"
```
Copy the `id` it gives you. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_ID` with it.

### 1.4 Set secrets
```
wrangler secret put SALT
```
Enter any random string (e.g. `xK9mQ2pL7vR`). This strengthens encryption.

```
wrangler secret put CRON_PIN
```
Enter the PIN you'll use in the app (e.g. `1234`).

### 1.5 Deploy the worker
In the folder containing `worker.js` and `wrangler.toml`:
```
wrangler deploy
```
You'll get a URL like: `https://bond-booker.yourname.workers.dev`
**Save this URL** — you'll need it in the app.

---

## Part 2 — Host the web app on GitHub Pages

### 2.1 Create a GitHub account
Go to https://github.com and sign up (free).

### 2.2 Create a new repository
1. Click **New repository**
2. Name it `bond-book`
3. Set it to **Public**
4. Click **Create repository**

### 2.3 Upload the files
Upload these files to the repository:
- `index.html`
- `manifest.json`
- `sw.js`

(You can drag and drop them in the GitHub web interface)

### 2.4 Enable GitHub Pages
1. Go to your repo → **Settings** → **Pages**
2. Under "Branch", select `main` and click **Save**
3. Your app will be live at: `https://yourusername.github.io/bond-book`

---

## Part 3 — Set up the app on your phone

### iPhone
1. Open Safari and go to `https://yourusername.github.io/bond-book`
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Name it `Bond Book` → tap **Add**

### Android
1. Open Chrome and go to your app URL
2. Tap the **⋮ menu** → **Add to Home screen**
3. Tap **Add**

---

## Part 4 — Configure the app

1. Tap the **Bond Book** icon to open it
2. Go to **Settings** (bottom nav)
3. Enter your **Worker URL** (from Part 1.5)
4. Enter your **Bond Athletic email and password**
5. Set a **PIN** (you'll enter this each time you book)
6. Add your classes — day, start time, end time
7. Tap **Save Config**

---

## Part 5 — Book a class

**Manually (phone):**
1. Open Bond Book
2. Tap **BOOK** next to the class you want
3. Enter your PIN
4. Done ✅

**All at once:**
- Tap **BOOK ALL DUE NOW** — it'll book any class that ended ~30 mins ago

---

## Part 6 — Auto-booking on PC (optional)

This runs automatically ~30 mins after each class ends using Windows Task Scheduler.

### One-time setup per class:
1. Open **Task Scheduler** → **Create Basic Task**
2. Name: e.g. `Bond Book - Monday 6am`
3. Trigger: **Weekly** → select Monday → time: `07:30 AM` (30 mins after a 7am class ends)
4. Action: **Start a program**
   - Program: `curl`
   - Arguments: `-X POST https://bond-booker.yourname.workers.dev/book-all`
5. Repeat for each class day/time

That's it — the Worker does the booking silently in the background, no phone needed.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach worker" | Check the Worker URL in Settings — no trailing slash |
| "Login failed" | Double-check email/password in Settings |
| "Could not find class" | Check the time format matches exactly (e.g. `6:00 AM` not `6am`) |
| App won't install to home screen | Must use Safari on iPhone, Chrome on Android |
| Worker not deploying | Run `wrangler whoami` to check you're logged in |

---

## Security notes
- Your credentials are encrypted with AES-256-GCM using your PIN before being stored in Cloudflare
- The PIN never leaves your device
- The Worker URL is the only thing that could be guessed, and it requires your PIN to do anything with credentials
- Don't share your Worker URL publicly
