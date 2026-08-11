# SendMyBuyer - Wholesale Deals For Sale & Disposition Team

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
- On a buyer's pitch detail, a rep can edit that one buyer's own info right
  there — phone numbers, email, county, Drive link, last known purchase
  price, price range, and asset categories — so if you learn something new
  about a buyer while working them, you can fill it in without needing admin
  to touch the backend sheet. It's always one buyer at a time; only admin can
  mass-edit many at once (see Buyer Leads below).
- **Buyer Leads** — a separate "Buyer Leads" tab shows every buyer they've
  been given for a deal we currently have to sell (never a bare contact list
  with nothing to offer them), with up to three phone numbers each showing
  its own phone-type hint (Landline = call only, Mobile = call or text) — a
  rep picks which number they're using each time they log a contact — plus
  which deal it's for and a status (Not Contacted, Awaiting Response,
  Follow-Up Due, Responded, Fully Worked). If a deal closes before a buyer
  responds, that item just shows "deal closed — no action needed" instead of
  piling up as overdue. Logging a contact records the method, which number
  was used, whether the buyer responded, and deal-specific feedback notes; a
  separate **General Buyer Notes** field (ARV%, price range, areas of
  interest, cash vs. financed) travels with the buyer across every deal
  they're ever pitched, anywhere in the country — so a buyer who passed on a
  deal in one city can be correctly re-pitched the moment a matching deal
  shows up in a different one. If admin's added the buyer's email or a Drive
  link to their documents (proof of funds, signed agreements), those show up
  here too. If a buyer asks not to be contacted again, a rep can mark **Do
  Not Contact** right from this screen — that immediately stops any further
  calls/texts from being logged for them, on any number, and stops them from
  being given a new pitch.
- Deals with a General Drive Link show an "Open Drive Folder" link right on
  the deal — marketing photos, comps, whatever admin's put there. A deal's
  Sensitive Drive Link (contracts, financials) never appears to reps at all.

**Admin side** (behind the same login, when marked as admin):

- A **Work as Rep** button in the header lets admin drop into these same
  rep screens at any time — handy for working deals directly while the rep
  side is still being built out or the team is still small. It's just a
  display toggle (nothing about the login or its permissions changes), and
  it resets back to the admin view on next login. Admin can also be picked
  as a "give to" target anywhere a buyer lead gets handed to a rep, so
  there's something to actually work once you switch over.

- **Deals** — add deals, change a deal's status (Active, Sold, Dead, Under
  Contract, On Hold, or whatever categories you've defined), edit the
  **Address / City / State / Zip** at any time after creation (e.g. a typo,
  or details that firm up after the deal's already been added), manage
  exactly which reps can see each deal, assign it a **Deal Code** and **County**
  (what reps actually see instead of the address), an **Asset Category** and
  any extra **cities to also match** in the same state (for buyer-matching —
  see Buyer Leads below), and set two Google Drive
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
  rights per person, reset anyone's password. No self-serve signup — you
  create every login yourself. Each rep's row (including your own admin
  account) shows their **phone number** and **email**, **# of active deals**
  they can currently work (every active deal for an all-access rep,
  otherwise however many they've been specifically assigned), and **last
  active** (their most recent login) — a quick way to spot who's overloaded
  or who's gone quiet. **Edit Details** on a rep lets you set/update their
  phone, email, and preferred buyer-lead area — city and zip are still
  single values, but **states are now a comma-separated list** (e.g. "AZ,
  NV, CA"), so a rep who works multiple states can be matched across all of
  them instead of just one. A separate **"Want to Join?" Contact** box at
  the top of the Team tab sets the name/phone/email shown on the login
  page for anyone without an account yet who's asking how to get set up
  with deals — it isn't tied to any real login, so you can point it at
  yourself, someone else, or swap it any time.
- **Facebook Approvals** — every pending post request across all deals in one
  place, approve or reject with an optional note.
- **Buyer Matches** — every interested-buyer match across all deals in one
  place, so you can see at a glance who's Negotiating or Closing and pick up
  the conversation (rep's notes are visible to you the moment they're
  logged) to close the deal yourself, keeping the rep who brought the buyer
  updated as it moves.
- **Buyer Leads** — upload a CSV file in any column order and it guesses
  which column is which (Name, Phone × 3, Phone Type × 3, City, State, Zip,
  County, Email, Asset Categories) from your headers, shows you a preview and
  the guessed mapping so you can fix anything it got wrong, then imports — or
  just paste rows directly if that's easier for a short list. Each buyer's
  profile also holds an editable Email, County, up to three phone numbers,
  Asset Categories (what they're looking for — Single Family, Multifamily
  4+ Units, Fix and Flip, etc. — customizable, see Asset Categories below),
  a price range they've told us they want (if known), a note on the last
  price we know they've actually paid for something similar, and a Drive
  Link for their own documents (proof of funds, signed agreements) —
  visible to any rep who's been given that buyer, editable by admin only.
  Every contact a rep logs — and every "Interested Buyer" logged on a deal
  page — can optionally record what % of ARV or as-is value that buyer
  expressed interest at, building real data over time on what buyers
  actually pay relative to value. The table filters by Asset Category and
  State, lets you select everyone on the page or the first N matching your
  filter (e.g. "give me 50 Single Family buyers"), and give that whole
  selection to one rep for one deal at once — and paginates at 50 rows so a
  list of 100+ never loads all at once. Give a buyer to a rep individually,
  or give a whole batch at once for one specific deal — matched
  automatically by State, by the deal's City or any of its additional
  "match cities" in the same state (so "Phoenix" and " phoenix " are
  treated the same, and you're not limited to one exact city), by Asset
  Category, and by price range when both sides have one set — every "give"
  pairs one buyer with one deal,
  so nobody's queue ever fills up with buyers there's nothing active to sell
  them. Set a rep's preferred working area on the Team tab, and turn on
  **Auto-Feed** to automatically give more matching buyer leads, per deal, to
  any rep who's worked through everything they've already been given for it
  — so the calling queue never runs dry without you manually handing out
  more batches. A buyer's General Notes and full pitch/contact history stay
  visible from their profile even after a pitch is withdrawn or its deal
  closes. Once you've selected a batch of leads, a **Mass Edit Selected
  Leads** panel appears — check off just the fields you want to backfill
  (Asset Categories, County, Last Known Purchase Price, Price Range) and it
  applies only those to every selected lead at once, leaving everything else
  untouched. Handy for "I never set Asset Type on these 50 imports and don't
  want to open the spreadsheet." Importing now also checks email (not just
  phone) for duplicates, and phone matching ignores formatting and a leading
  "1" country code, so "555-123-4567" and "+1 (555) 123-4567" are recognized
  as the same number. For anything that slipped in before that — old
  imports, manual paste, or direct spreadsheet edits — **Scan for
  Duplicates** finds existing leads sharing a phone or email, groups them,
  and lets you pick which one to keep; the rest get folded into it (their
  pitches and full contact history move over — dropping only a pitch that
  would otherwise duplicate one the kept lead already has on the same deal —
  and any profile field the kept lead is missing gets backfilled from a
  duplicate that has it) and removed.
- **Pitches** — every open pitch across the whole team in one table, instead
  of having to open each buyer's detail panel one at a time. Search by buyer
  or deal, filter by team member or deal, and reassign or **Withdraw** any
  pitch right from the row — or select several (even across different reps
  and deals) and **Withdraw Selected** to pull back a batch at once, e.g.
  everything a rep has on a deal that just went dead so they're free to pick
  up something new. Withdrawing only removes the pitch itself; that buyer's
  full contact history stays intact. Giving a buyer a pitch is now
  concurrency-safe on the backend (two near-simultaneous requests — a
  double-click, or a manual give landing at the same moment as auto-feed —
  can no longer both succeed and create a duplicate), and the single "Give"
  button on a buyer's own detail panel now shows an error if it can't give
  (previously it failed silently, which was easy to mistake for nothing
  happening and re-click into a duplicate).
- **Status Categories** — add or remove the status options offered in the
  Deals dropdowns.
- **Asset Categories** — add or remove the property-type categories buyers
  and deals are matched by (Single Family, Multifamily, Fix and Flip, etc.).

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure for login, rep view, and admin view |
| `app.js` | All login, rep, and admin logic + API calls |
| `config.js` | The one thing you edit after deployment — your Apps Script Web App URL |
| `backend/Code.gs` | The entire backend — paste into a Google Sheet's Apps Script editor |
| `SETUP.md` | Step-by-step deployment instructions |

Internal use.
