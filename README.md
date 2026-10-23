# القطة ياعبدو · Al-Gutta Ya Abdo

A tiny "who owes whom" app for friends and family. Each friend has one counter; settle up and it returns to zero.
Friends open a shared link in any browser and can see and add entries without installing anything. It can also be installed to the home screen like a normal app (PWA).

**Files**

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The app (plain HTML/CSS/JS, no build step) |
| `config.js` | Where the cloud database keys go |
| `supabase/schema.sql` | Database setup, run once |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline use and home-screen install |
| `tools/` | Scripts that regenerate the icons (`node tools/make_svgs.mjs && python tools/make_pngs.py`) |

Without keys in `config.js` the app runs in **demo mode**: it works fully, but data stays on one device and links don't work across phones.

---

## 1. Cloud (≈5 minutes, free)

1. Create a free account at <https://supabase.com> and click **New project** (any name, e.g. `al-gutta`; pick the closest region).
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API Keys** (or **Data API**) and copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **publishable** key (or the legacy **anon public** key). This key is meant to be public, and the database only answers to valid tab links.
4. Paste both into `config.js`.

## 2. Put it online (GitHub Pages, free)

```bash
git add -A && git commit -m "Connect cloud"
gh repo create al-gutta --public --source . --push
gh api -X POST repos/{owner}/al-gutta/pages -f "source[branch]=main" -f "source[path]=/"
```

After about a minute the app is live at `https://<your-github-username>.github.io/al-gutta/`.
Open it on your phone, add a friend, and send them the link on WhatsApp.

> The WhatsApp preview image uses an absolute URL in `index.html` (`og:image`). If you use a different repo name or domain, update it there.

## Install on a phone

- **Android (Chrome):** open the site, then tap **Install app** in Settings or the browser's install prompt.
- **iPhone (Safari):** tap **Share**, then **Add to Home Screen**.

## Updating the app

Edit the files, bump `VERSION` in `sw.js` (e.g. `qy-v2`) so phones pick up the change, then commit and push.

## Later: Google Play

The same web app can be wrapped for Google Play as a Trusted Web Activity, using Bubblewrap or <https://www.pwabuilder.com>. No rewrite is needed.
