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
  "all deals" if the admin granted that) — identified only by a **Deal Code**
  (e.g. "A-1") plus City/State/Zip/County/Price. The exact street address is
  hidden by default, with one deliberate exception: admin can disclose it to
  a specific team member for a specific deal (once they've proven they work
  it correctly), and revoke that access just as easily — see **Address
  Access** in the admin section below. Each deal also shows **ARV**,
  **Rehab Estimate**, and a computed **Gross Margin** (ARV − Rehab Estimate
  − Price) so reps have what they need to pitch buyers.
- Each deal shows the standing SOP:
  1. Contact buyers from the lead list, or submit a Facebook post here for
     admin approval before posting — including which groups you intend to
     post it to.
  2. As soon as a buyer shows real interest, log them under "Interested
     Buyers" — this emails admin immediately. Keep pasting conversation
     updates into that buyer's notes as things progress, and mark the match
     **Active Match**, **Negotiating**, **Closing**, or **Dead Match** (buyer
     couldn't agree) as it plays out — an easy-to-follow, deal-by-deal picture
     of who's actually closing.
- Every Facebook post submission and every interested-buyer submission emails
  the admin automatically.
- **Buyer Leads** — a separate "Buyer Leads" tab shows every buyer they've
  been given for a deal we currently have to sell (never a bare contact list
  with nothing to offer them), each showing a phone-type hint (Landline =
  call only, Mobile = call or text), which deal it's for, and a status (Not
  Contacted, Awaiting Response, Follow-Up Due, Responded, Fully Worked). If a
  deal closes before a buyer responds, that item just shows "deal closed —
  no action needed" instead of piling up as overdue. Logging a contact
  records the method, whether the buyer responded, and deal-specific
  feedback notes; a separate **General Buyer Notes** field (ARV%, price
  range, areas of interest, cash vs. financed) travels with the buyer across
  every deal they're ever pitched, anywhere in the country — so a buyer who
  passed on a deal in one city can be correctly re-pitched the moment a
  matching deal shows up in a different one. If admin's added the buyer's
  email or a Drive link to their documents (proof of funds, signed
  agreements), those show up here too.
- Deals with a General Drive Link show an "Open Drive Folder" link right on
  the deal — marketing photos, comps, whatever admin's put there. A deal's
  Sensitive Drive Link (contracts, financials) never appears to reps at all.

**Admin side** (behind the same login, when marked as admin):

- **Deals** — add deals, change a deal's status (Active, Sold, Dead, Under
  Contract, On Hold, or whatever categories you've defined), manage exactly
  which reps can see each deal, assign it a **Deal Code** and **County**
  (what reps actually see instead of the address), and set two Google Drive
  links: a **General Drive Link** (visible to your team — photos, comps,
  marketing) and a **Sensitive Drive Link** (admin-only — contracts,
  financials, seller personal info). **Address Access** on each deal lets
  you disclose the exact address to specific team members with a click, and
  revoke it just as easily — nobody has it by default, and there's a chip
  list showing exactly who currently does. A private **Source Link** + **Admin
  Notes** section on every deal is visible to you alone — paste the original
  online listing link, track sourcing details, whatever you don't want any
  rep to ever see.
- **Team** — add/remove team members, toggle "all-deal access" or admin
  rights per person, reset anyone's password. No email or self-serve signup —
  you create every login yourself.
- **Facebook Approvals** — every pending post request across all deals in one
  place, approve or reject with an optional note.
- **Buyer Matches** — every interested-buyer match across all deals in one
  place, so you can see at a glance who's Negotiating or Closing and pick up
  the conversation (rep's notes are visible to you the moment they're
  logged) to close the deal yourself, keeping the rep who brought the buyer
  updated as it moves.
- **Buyer Leads** — paste-import a batch of buyer/LLC contacts (Name, Phone,
  Phone Type, City, State, Zip, and optionally Email). Each buyer's profile
  also holds an editable Email and a Drive Link for their own documents
  (proof of funds, signed agreements) — visible to any rep who's been given
  that buyer, editable by admin only. Give one to a rep individually, or give a
  whole batch at once for one specific deal (matched to that deal's own
  city/state/zip automatically) — every "give" pairs one buyer with one deal,
  so nobody's queue ever fills up with buyers there's nothing active to sell
  them. Set a rep's preferred working area on the Team tab, and turn on
  **Auto-Feed** to automatically give more matching buyer leads, per deal, to
  any rep who's worked through everything they've already been given for it
  — so the calling queue never runs dry without you manually handing out
  more batches. A buyer's General Notes and full pitch/contact history stay
  visible from their profile even after a pitch is withdrawn or its deal
  closes.
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
