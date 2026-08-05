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
     buyer's name under "Interested Buyers."
- Every Facebook post submission emails the admin automatically, and shows
  the rep its own Pending/Approved/Rejected status (with the admin's note, if
  rejected).

**Admin side** (behind the same login, when marked as admin):

- **Deals** — add deals, change a deal's status (Active, Sold, Dead, Under
  Contract, On Hold, or whatever categories you've defined), and manage
  exactly which reps can see each deal.
- **Team** — add/remove team members, toggle "all-deal access" or admin
  rights per person, reset anyone's password. No email or self-serve signup —
  you create every login yourself.
- **Facebook Approvals** — every pending post request across all deals in one
  place, approve or reject with an optional note.
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
