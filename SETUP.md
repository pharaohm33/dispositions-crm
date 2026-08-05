# Setup — Google Sheet + Apps Script Backend

This site has no server of its own. The rep login, admin panel, deal
assignments, interested-buyer log, and Facebook post approvals all talk to a
small Google Apps Script "Web App" that reads and writes a Google Sheet you
own. You only need to do this once.

## 1. Create the Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new blank
   spreadsheet. Name it something like **Dispositions CRM — Data**.
2. Leave it empty — the script creates its own tabs (`Reps`, `Deals`,
   `Assignments`, `InterestedBuyers`, `FBPostRequests`, `StatusOptions`,
   `BuyerLeads`, `Pitches`, `BuyerLeadContacts`) automatically the first time
   it runs.

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

## Optional: automatic auto-feed (time-driven trigger)

The **Buyer Leads → Auto-Feed** toggle in the admin panel works on its own
whenever you click "Run Auto-Feed Now." If you'd rather it run in the
background without you clicking anything:

1. In the Apps Script editor, use the function dropdown at the top to select
   **installAutoFeedHourlyTrigger**, then click **Run**.
2. That's it — it creates an hourly time-driven trigger for you. You can
   confirm it under **Triggers** (the clock icon on the left).
3. It only actually assigns anything when the Auto-Feed toggle is on and a
   team member has run out of leads needing action — running the trigger
   costs nothing otherwise. Don't run `installAutoFeedHourlyTrigger` more
   than once, or you'll end up with duplicate hourly triggers (check
   Triggers first if unsure).

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
  only offers whatever's currently listed in `StatusOptions`. `DealCode` (a
  short label like "A-1" you assign) plus City/State/Zip/County/Price is
  everything a rep sees to identify a deal by default. `ARV` and
  `RehabEstimate` are visible to reps too (they use these to pitch buyers);
  `GrossMargin` (ARV − RehabEstimate − Price) is never stored — it's computed
  fresh on every read from those three fields, so it can't go stale, and
  shows as "—" until all three are filled in. `GeneralDriveLink` (any
  Google Drive folder/file URL) is visible to every rep with access to the
  deal; `SensitiveDriveLink` (contracts, financials, seller personal info),
  `AdminPrivateNotes` (your own scratchpad), and `SourceLink` (where you
  found the deal online) are all admin-only and stripped out of every
  non-admin response server-side, with no rep-facing unlock at all. `Address`
  is admin-only by default too, but — unlike those three — it has a
  deliberate, reversible unlock: see AddressGrants below.
- **Assignments** — which non-all-access reps can see which deals. Managed
  from a deal's detail panel in the admin view.
- **AddressGrants** — the one exception to "reps never see the address":
  admin can explicitly disclose a specific deal's exact address to a
  specific team member from that deal's **Address Access** section (only
  offered to reps who already have access to the deal), and revoke it just
  as easily. Starts empty for every deal — nobody has address access until
  you deliberately turn it on for them. Doesn't extend to the Buyer Leads
  calling-list Pitch view, which never shows the address regardless.
- **InterestedBuyers** — logged by whichever rep has access to that deal, the
  moment a buyer shows real interest (Step 2). Submitting one emails
  `ADMIN_NOTIFY_EMAIL` immediately — there's no approval gate anymore, since
  reps never see the address regardless. `MatchStatus` (Active Match /
  Negotiating / Closing / Dead Match) tracks the buyer<->deal relationship
  itself, editable by admin or any rep with access to that deal; `Notes` is a
  running conversation log either can keep updating over time ("copy and
  paste important notes of the conversation"); `AdminNote` is your own
  separate note on the match, admin-only.
- **FBPostRequests** — a rep's Step 1 ask for approval before posting to
  Facebook, including which groups they intend to post to. Submitting one
  emails `ADMIN_NOTIFY_EMAIL` automatically.
- **StatusOptions** — the list of deal-status categories offered in dropdowns
  (Active, Under Contract, Sold, Dead, On Hold by default). Editable from the
  **Status Categories** admin tab.
- **BuyerLeads** — the master buyer/LLC calling list, imported by pasting
  CSV/spreadsheet text into the **Buyer Leads** admin tab (Name, Phone, Phone
  Type, City, State, Zip, and optionally Email — Email must come last in the
  pasted row since it's optional, so the other columns' positions never
  shift whether or not a given row has one). A buyer lead has no assignment
  of its own — `GeneralNotes` is a free-text cross-deal profile (ARV%, price
  range, areas of interest, cash vs. financed) that persists no matter how
  many different deals it's ever pitched against, and `DriveLink` is a
  Google Drive folder/file URL for that buyer's own documents (proof of
  funds, signed agreements). `DriveLink` and `Email` are admin-editable only
  (from a buyer's detail panel in the **Buyer Leads** tab), though any rep
  with an open pitch on that buyer can see them; `GeneralNotes` stays
  editable by any rep who's had a pitch on that buyer, same as before.
- **Pitches** — "give this buyer lead to this rep, for this one specific
  deal." This is the only thing that puts a buyer in a rep's queue or blocks
  Auto-Feed — a buyer lead with no open pitch just sits in the pool,
  generating no follow-up pressure for anyone, so nobody's queue fills up
  with buyers there's nothing currently for sale to offer them. Give pitches
  from the **Buyer Leads** admin tab, individually or in bulk per deal;
  reassign or withdraw them from a buyer's detail panel.
- **BuyerLeadContacts** — every call/text a rep logs against one specific
  Pitch, with free-text notes on the buyer's feedback about that deal. This
  is both the 24-hour-response SOP tracker (scoped to that one buyer+deal
  pairing) and the history that feeds `GeneralNotes` over time. Withdrawing
  a Pitch never deletes this history.
- **Calling hours + call-first, enforced server-side** — a rep (not admin)
  can't log a contact outside 8am–7pm in the buyer's own time zone, looked
  up from their State via a built-in state→timezone table (an approximation
  — exact city-level lookup would need a paid geocoding API, so states that
  span multiple zones just get their majority zone). Texting is blocked
  entirely until that specific buyer has responded to a prior call — high-
  volume texting with no reply history is what gets a business number
  flagged or blocked from texting by carriers, so every buyer gets called
  first, always.
