# Dispositions CRM

An internal tool for a dispositions team to work active deals: admin assigns
deals to specific reps (or gives them access to everything), and each rep
works their SOP against every deal they can see.

Same spirit as [SendMySeller](https://github.com/pharaohm33/seller-lead-form)
— plain HTML/CSS/JS, no build step, no framework — except this one's audience
is your own team rather than the public, so it's a username/password login
instead of a public wizard. Hosted on GitHub Pages; data lives in a Google
Sheet you own via a small Apps Script backend (see [SETUP.md](SETUP.md)).

## What it does

**Rep side** (after logging in):

- Sees every deal they've been given access to (either specific deals, or
  "all deals" if the admin granted that).
- Each deal shows the standing SOP:
  1. Contact buyers from the lead list, or submit a Facebook post here for
     admin approval before posting — including which groups you intend to
     post it to.
  2. Once a buyer says the deal may work but wants the address, log that
     buyer's name under "Interested Buyers." The deal's exact street address
     stays hidden (server-side, not just in the UI) until admin approves that
     specific buyer — once approved, the rep sees the address along with a
     warning naming exactly who they're allowed to share it with, and a
     reminder that sharing it with anyone else risks the deal and their
     standing on the team.
- Every Facebook post submission and every interested buyer submission emails
  the admin automatically, and shows the rep its own Pending/Approved/Rejected
  status (with the admin's note, if rejected).
- **Buyer Leads** — a separate "Buyer Leads" tab holds their own personal
  batch of buyer/LLC contacts to call or text, each showing a phone-type hint
  (Landline = call only, Mobile = call or text) and a status (Not Contacted,
  Awaiting Response, Follow-Up Due, Responded, Fully Worked). Logging a
  contact records the method, whether the buyer responded, which deal (if
  any) was discussed, and freeform notes — that history is what builds a
  most-active-buyers picture over time and by area.

**Admin side** (behind the same login, when marked as admin):

- **Deals** — add deals, change a deal's status (Active, Sold, Dead, Under
  Contract, On Hold, or whatever categories you've defined), and manage
  exactly which reps can see each deal.
- **Team** — add/remove team members, toggle "all-deal access" or admin
  rights per person, reset anyone's password. No email or self-serve signup —
  you create every login yourself.
- **Facebook Approvals** — every pending post request across all deals in one
  place, approve or reject with an optional note.
- **Buyer Approvals** — every pending interested-buyer submission across all
  deals in one place; approving one is what unlocks that rep's view of that
  deal's exact address.
- **Buyer Leads** — paste-import a batch of buyer/LLC contacts (Name, Phone,
  Phone Type, City, State, Zip); hand out leads to a specific rep individually
  or in bulk (optionally filtered by city/state/zip — leads are never shared
  between reps unless you deliberately reassign one); set a rep's preferred
  working area on the Team tab; and turn on **Auto-Feed** to automatically top
  up any rep who's worked through everything assigned to them, so the calling
  queue never runs dry without you manually re-assigning batches.
- **Status Categories** — add or remove the status options offered in the
  Deals dropdowns.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure for login, rep view, and admin view |
| `app.js` | All login, rep, and admin logic + API calls |
| `config.js` | The one thing you edit after deployment — your Apps Script Web App URL |
| `backend/Code.gs` | The entire backend — paste into a Google Sheet's Apps Script editor |
| `SETUP.md` | Step-by-step deployment instructions |

Internal use.
