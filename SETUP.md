# Setup — Google Sheet + Apps Script Backend

This site has no server of its own. The rep login, admin panel, deal
assignments, interested-buyer log, and Facebook post approvals all talk to a
small Google Apps Script "Web App" that reads and writes a Google Sheet you
own. You only need to do this once.

## 1. Create the Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank
   spreadsheet. Name it something like **Dispositions CRM — Data**.
2. Leave it empty — the script creates its own tabs (`Reps`, `Deals`,
   `Assignments`, `InterestedBuyers`, `FBPostRequests`, `StatusOptions`)
   automatically the first time it runs.

## 2. Add the script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete whatever is in the default `Code.gs` editor.
3. Copy the entire contents of [`backend/Code.gs`](backend/Code.gs) from this
   repo and paste it in.
4. Click the **Save** icon (or Ctrl/Cmd+S).

## 3. Set your secrets (Script Properties)

Still in the Apps Script editor: **Project Settings** (the gear icon on the
left) → scroll to **Script Properties** → **Add script property**. Add these:

| Property | Value |
|---|---|
| `SESSION_SECRET` | Any long random string (mash the keyboard for 30+ characters) — this signs login sessions |
| `ADMIN_NOTIFY_EMAIL` | The inbox that should get an email whenever a rep submits a Facebook post for approval |

Neither of these ever appears in the public GitHub repo or the browser — they
live only inside this Apps Script project.

## 4. Deploy as a Web App

1. Back in the editor, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Settings:
   - **Execute as:** Me (your Google account)
   - **Who has access:** Anyone
4. Click **Deploy**.
5. The first time, Google will ask you to authorize the script (it needs
   permission to read/write the Sheet and send email on your behalf via
   `MailApp`). Click through the "unverified app" warning — it's your own
   script — and allow it.
6. Copy the **Web app URL** you're given (ends in `/exec`).

## 5. Wire it into the site

1. Open [`config.js`](config.js) in this repo.
2. Replace `PASTE_YOUR_DEPLOYED_WEB_APP_URL_HERE` with the URL you just
   copied.
3. Commit and push. GitHub Pages will pick up the change automatically.

To sanity-check the deployment on its own, paste the Web App URL into a
browser tab with `?action=ping` on the end — you should see
`{"ok":true,"message":"Dispositions CRM backend is alive."}`.

## Redeploying after a change

If you (or I) ever change `Code.gs`, you must redeploy for it to take effect:
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**.
Simply saving the file is not enough.

## 6. Create your first admin login

The site has no signup form — every login (including yours) is a row you add
to the `Reps` sheet tab yourself, once, directly in Google Sheets:

1. Open the `Reps` tab (created automatically after step 4's first ping, or
   after your first login attempt).
2. You need a password *hash*, not the plain password, in that row — the
   easiest way to generate one correctly is to temporarily add yourself with
   any password through a teammate's admin panel once it exists, or ask me to
   run a one-off setup script. If this is the very first account and no admin
   panel exists yet, run this once from the Apps Script editor (**Run →
   select function → `bootstrapFirstAdmin`**) after editing the placeholder
   name/username/password inside it — see the function at the bottom of
   `Code.gs`.
3. After that first admin exists, everyone else (reps and additional admins)
   can be added straight from the **Team** tab in the admin panel — no more
   manual Sheet editing needed.

## Data model

- **Reps** — one row per login (rep or admin). `AllAccess` = TRUE means they
  see every deal regardless of the `Assignments` tab. `IsAdmin` = TRUE gates
  the whole admin panel.
- **Deals** — one row per property. `Status` is free text but the admin panel
  only offers whatever's currently listed in `StatusOptions`.
- **Assignments** — which non-all-access reps can see which deals. Managed
  from a deal's detail panel in the admin view.
- **InterestedBuyers** — logged by whichever rep has access to that deal, per
  your Step 2 SOP (buyer wants the address).
- **FBPostRequests** — a rep's Step 1 ask for approval before posting to
  Facebook, including which groups they intend to post to. Submitting one
  emails `ADMIN_NOTIFY_EMAIL` automatically.
- **Address secrecy** — a deal's exact street address is withheld from every
  non-admin session (stripped server-side, not just hidden in the UI) until
  that specific rep has at least one interested buyer you've approved on that
  deal. Submitting an interested buyer emails `ADMIN_NOTIFY_EMAIL` with the
  buyer's full name; once you approve that buyer from the **Buyer Approvals**
  tab (or right on the deal's detail panel), the rep sees the address along
  with a warning naming exactly which buyer(s) they're allowed to share it
  with.
- **StatusOptions** — the list of deal-status categories offered in dropdowns
  (Active, Under Contract, Sold, Dead, On Hold by default). Editable from the
  **Status Categories** admin tab.
