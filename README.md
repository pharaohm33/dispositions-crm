# SendMyBuyer - Wholesale Deals For Sale & Disposition Team

An internal tool for a dispositions team to work active deals: admin assigns
deals to specific reps (or gives them access to everything), and each rep
works their SOP against every deal they can see.

Same spirit as [SendMySeller](https://github.com/pharaohm33/seller-lead-form)
— plain HTML/CSS/JS, no build step, no framework. Unlike SendMySeller's
public wizard, this one's login-gated — but anyone can create their own
account (see **Accounts &amp; Sign Up** below), it's just that a brand-new
account starts with zero deal access until admin assigns some. Hosted on
GitHub Pages; data lives in a Google Sheet you own via a small Apps Script
backend (see [SETUP.md](SETUP.md)).

## What it does

**Accounts &amp; Sign Up:**

- Anyone can create their own account from the login screen — **Sign Up**
  toggles to a form for Name, Email, Phone (optional), a self-identified
  **I am a...** (Buyer, Wholesaler, Realtor, or Other), and a password (8+
  characters). Username is just the email, lowercased. The account is
  **active immediately** — no approval queue — but starts with zero deal
  access: no all-deal access, not assigned to anything, so a brand-new
  signup sees an empty Deals tab until admin assigns them something
  (individually, or via **Assign to all users** / **Assign to all users
  with no assigned deals** the next time a deal's added — see Deals below).
  Admin gets an email the moment someone signs up. Self-signup can never
  create an admin account. Type is shown in the Team tab so admin can see
  who's who, and it does gate a couple of things: a **Buyer** never sees
  the "build your own buyer list" card or its guide/SOP at all (see Buyer
  Leads below); **Wholesaler**, **Realtor**, and **Other** additionally get
  a "text us once you have an interested buyer" line on the Deals tab SOP.
  The signup form also has a small **slider-puzzle CAPTCHA** — drag a piece
  until it visually completes a puzzle before Sign Up will submit. It's a
  homegrown, no-dependency check (no reCAPTCHA/hCaptcha account needed):
  the server picks a random target position and signs it (HMAC + a 5-minute
  expiry), the piece always shows the real art from that exact spot so
  it only "clicks in" once the slider matches, and the position/token/
  timing are all re-verified server-side on submit — a request that skips
  calling for a challenge, invents its own answer, or replays an old one
  gets rejected. This is explicitly **not** meant to stop a determined,
  targeted attacker (the target position is necessarily visible in the
  challenge response, since the page has to know it to draw the piece) —
  it's meant to filter out the much more common case of a generic bot
  blasting a plain POST at the signup endpoint with no idea it needs to
  solve anything at all.
- **Forgot password?** on the login screen doesn't reset anything itself —
  there's no email-reset flow — it just surfaces the same **"Need Help
  After Signing Up?"** contact info admin's already set (Team tab) so the
  person knows who to actually ask. That same contact is also who gets
  emailed for a rep's **Request Address Access** (see Address disclosure
  below), and once logged in, any non-admin session sees "Support: [phone]"
  in the header at all times, on every tab — one designated support
  contact for all three, not several things to keep in sync. Falls back to
  `ADMIN_NOTIFY_EMAIL` if no join contact email is set. This card is framed
  around *after* signing up specifically — signing up itself is self-serve
  (the Sign Up button right above it), so this isn't "how do I join," it's
  "I'm signed up and something's wrong / I have a question."

**Rep side** (after logging in):

- Sees every deal they've been given access to (either specific deals, or
  "all deals" if the admin granted that), organized by **how close each one
  is to actually closing** — Under Contract first, then Active, On Hold,
  Sold, with Dead sinking to the very bottom — and **State (alphabetically),
  then City within that state, then County** as tiebreakers behind status,
  so deals in the same area still cluster together within each status
  group instead of showing up in whatever order they were added. A custom
  status admin's added that isn't one of those five default ones lands
  between Active and On Hold rather than breaking the sort. Same
  organization on admin's own Deals table. Each deal is
  identified only by a **Deal Code**
  (e.g. "A-1") plus City/State/Zip/County/Price. The exact street address is
  hidden by default, with one deliberate exception: admin can disclose it to
  a specific team member for a specific deal (once they've proven they work
  it correctly), and revoke that access just as easily — see **Address
  Access** in the admin section below. The Deal Code always stays visible
  even once the address is disclosed (shown as a small tag alongside it)
  since it's the same label used over on Buyer Leads / Pitches, which never
  shows the address — keeping the code visible in both places is what lets
  a rep actually match a buyer's pitch back to the right deal at a glance.
  The Deals tab defaults its **Status** filter to **Active Only** — Dead
  and Sold deals stay out of the way unless a rep deliberately switches it
  to "All Statuses" or picks one of those closed statuses specifically, so
  there's no need to scroll past deals that aren't workable anymore. An
  **Asset Category** filter sits next to it. Each deal's card also shows
  whichever of **Asking Price**, **ARV**, **Rehab Estimate**, and **As-Is
  Value** are actually set on it, right in the list — only the ones with a
  real value show up (no "ARV: —" filler for a field admin left blank), so
  a rep can size up a deal's numbers without opening it.
  Once disclosed, the deal list shows the **full address** (street, city,
  state, zip) right on the card, not just a partial one — and the **County**
  underneath it, which is visible whether or not the address itself has been
  disclosed — so a rep scrolling a list with several similar deals in the same asset
  class can tell them apart and go straight into calls without opening each
  one first to check which is which. Each deal also shows **ARV**, **Rehab
  Estimate**, and a computed **Gross Margin** (ARV − Rehab Estimate − Price)
  so reps have what they need to pitch buyers — plus, when set, an **As-Is
  Value** and computed **As-Is Equity** (As-Is Value − Price) for a deal
  whose selling point is being undervalued as-is rather than a rehab
  spread, so it doesn't need ARV/Rehab filled in at all to still show reps
  the number that actually sells it. Price is labeled **Asking Price**
  everywhere it's shown (deal detail, the deals table, both Add/Edit Deal
  forms) — required on every deal, admin can't submit a new one without
  it (and can't clear it back out on an existing one via Edit, either) —
  since there's always supposed to be one. Price, ARV, Rehab Estimate, and
  As-Is Value are all auto-formatted with a `$` and commas the moment
  admin saves — type `500000`, `$500000`, or `500,000` and they all land
  the same way as `$500,000`; anything already formatted (or not a plain
  number at all, like a typed-out range) is left exactly as typed rather
  than being mangled.
- Right on the deal detail, **Match My Buyer Leads To This Deal** lets a
  rep self-serve the same auto-matching admin uses (same State, City equal
  to the deal's City or one of its Match Cities, compatible Asset Category)
  — pick how many, hit the button, and it gives that batch of matching
  leads to themselves for this deal (scoped to leads they can actually see:
  their own private uploads plus anything shared/admin-uploaded — never
  someone else's private list). They show up right after on the rep's own
  Buyer Leads tab to start calling. A rep can only give leads to
  themselves this way; giving to anyone else is still admin-only. Below
  that, a rep can instead check off one or more **specific cities**
  (grouped by state, sourced from every city that shows up across
  whatever leads that rep can see) to build a cold-call list that bypasses
  the deal's own State/City/Asset Category matching entirely — useful when
  a deal's buyer pool should be wider than what's formally set on it, or a
  rep wants to work a particular area on purpose. Matched as city+state
  together, not city name alone — two states can share a city name (a
  "Springfield, IL" and a "Springfield, OH"), so each checkbox is really a
  specific city-in-a-specific-state, never just a bare name that could
  silently pull in the wrong state's list. Leaving every city unchecked
  falls back to the normal matching, same as before. A Dead or Sold deal
  blocks this (and the normal matching above) either way — see
  the buyer-matching note earlier in this section. A **Full State** button
  sits next to each state's header in that same city list — click it to
  check every city under that state at once (handy when a list wasn't
  uploaded in city order to begin with, so hand-picking each one would be
  tedious), click it again to uncheck the whole state back off. Only
  cities the rep can actually see are ever offered here to begin with —
  their own uploads plus admin's shared pool, never another rep's private
  list. Each state's cities are **collapsed by default** — click the state
  name to expand or collapse just that one, so a rep with cities spread
  across several states isn't stuck scrolling one long flat list to find
  the ones they actually want; clicking Full State auto-expands that
  state so the result is visible right away.
- Each deal shows the standing SOP:
  1. **Call buyers from the lead list** — the main way to work a deal, and
     what the banner leads with. Match yourself to buyers on the deal (or
     cold-call specific cities from your own list, see above) and start
     dialing. Cold emailing buyers is also allowed, but talk to admin
     first — there's a specific outreach approach to keep those emails out
     of spam.
  2. As soon as a buyer shows real interest, log them under "Interested
     Buyers" — this emails admin immediately. Keep pasting conversation
     updates into that buyer's notes as things progress, and mark the match
     **Active Match**, **Negotiating**, **Closing**, or **Dead Match** (buyer
     couldn't agree) as it plays out — an easy-to-follow, deal-by-deal picture
     of who's actually closing. This section sits first on a deal's detail
     page too (labeled **Step 1**), right after the buyer-matching tools.
     **Follow up with everyone who's asked for more info every 1–3 days**,
     noting each touch so it's clear when someone was last contacted. A
     **Copy Info To Send Buyer** button sits right in the deal's info
     banner — one click copies the same Asking Price / ARV / Rehab
     Estimate / Gross Margin / As-Is Value / As-Is Equity / Description
     already shown there (only whichever fields are actually set, same
     rule as the banner itself) plus the Drive folder link, formatted to
     paste straight into a text or email. A long description gets a
     **"Shorten the long description"** checkbox (only appears past ~220
     characters) that trims it to a clean word boundary plus "..." — left
     checked by default for a quick text, uncheck it to copy the full
     description instead. The moment a buyer someone sends this to says
     they're interested, the rep is told right there to contact admin
     immediately for the address — never send it themselves.
  3. **Facebook posting is explicitly optional and secondary**, not a
     first-resort — the banner and the deal detail page (labeled just
     **"Optional"**, no step number, and using the muted secondary button
     style rather than the primary one) both say to lead with calling
     buyers instead. Once a post is approved and shared to a bunch of
     groups there's no way to pull it back or delete it if something turns
     out wrong (a bad price, the deal falling through, a typo) — every post
     still needs admin approval first regardless, but this framing exists
     so reps don't reach for it as the default the way they might for
     Step 1.
  4. **Address disclosure**, spelled out right in this same banner: pitch
     off the general deal info first (Deal Code, City/State/Zip, County,
     price — never the address). Only once a buyer has actually responded
     and specifically asks for the address — not just because a rep thinks
     it looks like a good fit — hit **Request Address Access** on that deal
     to email admin and ask for it. Sharing an address early, or with
     anyone besides that one legitimate buyer who asked, risks losing the
     deal and getting removed from the team.
  5. For a **Wholesaler**, **Realtor**, or **Other** signup specifically
     (not a Buyer, not a traditional admin-added account), this same banner
     adds one more line: once you have an interested buyer, text the "Want
     to Join?" phone number saying "Interested and want more information?"
     — in addition to, not instead of, logging them under Interested Buyers
     above.
- Every Facebook post submission and every interested-buyer submission emails
  the admin automatically.
- On a buyer's pitch detail, a rep can edit that one buyer's own info right
  there — phone numbers, email, county, Drive link, last known purchase
  price, price range, and asset categories — so if you learn something new
  about a buyer while working them, you can fill it in without needing admin
  to touch the backend sheet. It's always one buyer at a time; only admin can
  mass-edit many at once (see Buyer Leads below).
- That same pitch detail also has a **Deal Info** section, so a rep can see
  everything about the deal a matched buyer is for without leaving the
  pitch to go look it up separately: the Address (only if admin has
  specifically granted this rep access to it for this deal — same grant
  system and confidentiality warning as the deal's own detail page, not a
  new exception), Asset Type, Price, ARV, Rehab Estimate, Gross Margin,
  As-Is Value, As-Is Equity, the deal's own Drive Folder link (separate
  from the buyer's own Documents link right above it), and a Description /
  Notes block a rep can collapse — click its header to minimize it out of
  the way once they've read it, or expand it again any time. Admin always
  sees the Address here too, with no grant needed and no warning banner —
  same as admin already does on the deal itself — including while using
  **Work as Rep** to preview a rep's screen. When the address isn't
  disclosed yet, a **Request Address Access** button sits right there
  instead — the actual SOP: once a matched buyer has expressed real
  interest and specifically wants the address, a rep hits this (rather than
  asking off-platform) and it emails admin to grant it from that deal's
  Address Access section. Admin still makes the actual call on granting it;
  this only asks.
- **Buyer Leads** — a separate "Buyer Leads" tab shows every buyer they've
  been given for a deal we currently have to sell (never a bare contact list
  with nothing to offer them), laid out as a scrollable table — paginated at
  50 rows so a long list never loads all at once — with up to three phone
  numbers each showing its own phone-type hint (Landline = call only, Mobile
  = call or text) — a rep picks which number they're using each time they
  log a contact — plus which deal it's for and a status (Not Contacted,
  Awaiting Response, Follow-Up Due, Follow-Up In Progress, Responded, Fully
  Worked, or **Do Not Contact** — overrides every other status the moment
  either admin or the rep themselves marks that buyer DNC, everywhere that
  status shows: this list, admin's whole-team Pitches tab, and a buyer's
  own pitch history). Search by buyer/phone/city, filter down to one specific deal or
  one specific status (e.g. just Not Contacted, or everything already
  contacted), and sort by what needs attention first (the default),
  alphabetically by deal, or by when it was given — newest or oldest first;
  Do Not Contact buyers always sink to the bottom of the list no matter
  which sort is picked, since there's nothing left to do with them.
  A small circle to the left of each buyer's name toggles into a filled
  green arrow when clicked, with the whole row highlighted — a purely
  visual, local bookmark (not saved anywhere) so a rep can mark their place
  while scrolling up and down a long list and cross-checking a deal open
  elsewhere, without losing track of which name they're on. Click it again
  to unmark; more than one row can be marked at once.
  If a deal closes before a buyer responds, that item just shows "deal
  closed — no action needed" instead of piling up as overdue. Logging a
  contact records the method, which number
  was used, whether the buyer responded, whether a voicemail was left (Call
  only — the checkbox is hidden for Text, since it doesn't apply), and
  deal-specific feedback notes. A **Skip &amp; Next** button sits right next
  to Log Contact — mainly meant for landline-only buyers with no mobile to
  text, but it's flexible, use it however's useful. It logs a quick
  "Skipped" note (visible in Contact History, doesn't count toward the
  two-touch follow-up SOP or move a lead off Not Contacted by itself) and
  immediately opens the next lead in the rep's current filtered/sorted
  list — no need to close out and go re-find their place. A
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

- **Deals** — the table shows a **Coverage** column for each deal, e.g.
  "Admin + 2" or just "2 reps" — worked out with the exact same rule for
  admin as for any other team member: an all-access account counts toward
  every deal, everyone else only for deals they're specifically assigned to
  (same math as the Team tab's per-rep "# Deals," just inverted). If the
  logged-in admin themselves has all-deal access, or has specifically
  assigned themselves to a given deal (see **Assign Myself** below), it's
  called out by name as "Admin" with "+ N" for however many other team
  members also cover it; if not, it just shows the plain rep count for that
  deal (flagged in red if it's 0 — nobody, including admin, is on it).
  Turning an admin account's All Access off in the Team tab makes their
  coverage genuinely per-deal from then on, exactly like a regular rep,
  instead of showing up everywhere regardless. When adding a new deal,
  **Tell These Reps To Work This Deal** offers a one-click bulk assignment
  right at creation — **All Users** or **All Users With No Assigned Deals
  Right Now**; the same section also appears on an *existing* deal's detail
  page (below the one-by-one **Add Access** controls), with an **Assign
  Now** button, so you're not limited to sweeping reps in only at the
  moment a deal is created. "No assigned deals right now" is checked at
  the moment you click, and only counts deals a rep was given **one by
  one** — via **Add Access** or **Assign Myself** on a deal's detail page.
  A deal a rep received from a *previous* bulk batch (this same feature),
  or standing access via an **Asset Category**, does **not** count as
  "assigned" for this purpose — reps only drop out of future "unassigned"
  batches once someone hand-picks them for a specific deal. To keep a rep
  in the running for future "unassigned" batches even after they've been
  hand-picked for something, flip their **Bulk Assign Override** toggle on
  the Team tab (shown next to their name as an orange **Bulk Override**
  badge whenever it's on, so it stays obvious at a glance) — it bypasses
  the one-by-one exclusion entirely for that rep. If the deal has an
  **Asset Category** set, bulk-assigning also grants those reps
  **standing access to every deal in that category** — current ones right
  away, and any new one added later, automatically, with no need to hand
  it to them one at a time — rather than just this one deal; with no
  category set, it's a one-off grant for this deal only, same as before.
  Category access is what shows as **"Deals They're Specifically Told To
  Work On"** on a rep's Team tab row, and is editable there any time (Edit
  Details → check/uncheck a category) — not just at deal-creation time; a
  deal's own detail page also lists, read-only, who has access to it via
  category, pointing back to the Team tab to change it. All-access reps
  and admin are skipped either way, since they already see every deal
  without needing any of this. A deal's detail page also has a **Lock
  This Deal** toggle, entirely separate from Bulk Assign Override: when
  on, "Tell These Reps To Work This Deal" (both bulk-assign options) is
  disabled outright for that one deal — whoever's already on it keeps
  working it, but nobody new gets swept in, whether via "All Users,"
  "All Users With No Assigned Deals," or any future automated batch.
  **Add Access still works on a locked deal** — that's the deliberate,
  one-by-one override — only the bulk sweep itself is blocked. Unlocking
  is always a manual click, never automatic or time-based. A locked
  deal shows an orange **Locked** badge both on the deals table and on
  its own detail page, so it's obvious at a glance. Pairs with a new
  **Target Market** field on each rep (Team tab → Edit Details, separate
  from the buyer-lead "Preferred Area" fields above it — Target Market
  is about which state(s) a rep focuses on for *deals*, not buyer leads)
  — purely informational on its own, it grants nothing by itself. A
  deal's detail page has an **Auto-Assign By Target Market** button that
  looks up which active reps have that deal's state in their Target
  Market and lists them for you to pick from, with a checkbox to lock
  the deal to whoever you assign right there in the same step. If no
  rep has claimed that state yet, nothing comes back and the deal just
  stays open to everyone as usual — this is meant for the specific,
  deliberate case of "I've seen this person do well in this market,
  hand them this deal to focus on," not a first-resort or something
  that runs on its own; other deals in that same market can stay
  unlocked and shared if there's more volume than one rep needs. A
  **Give New Reps Access To The Open Pool** button on the Team tab is the
  one-click version of running "All Users With No Assigned Deals Right
  Now" across every open deal at once, instead of hand-assigning a fresh
  signup to each one individually — "open" meaning not Locked (a
  target-market deal stays reserved and is skipped entirely) and,
  per-deal, the same "only a manual, one-by-one grant disqualifies a rep"
  rule the single-deal version already uses. Safe to click again any time
  a new rep signs up — reps and deals already swept in from a previous
  click aren't re-added or duplicated, it only ever adds what's actually
  missing. An **Auto-Approve New Signups** toggle right below that button
  runs this same open-pool sweep automatically the instant someone signs
  up, rather than admin needing to notice the new-signup notification
  email and run it by hand — useful since that email can occasionally not
  make it through (e.g. around a backend redeploy). Off by default; when
  on, publicSignup itself calls the sweep synchronously before the
  account creation response even returns, so a fresh signup can see
  active deals immediately with zero admin involvement. Same rules as the
  manual button either way — Locked deals stay reserved, and a rep
  hand-picked for something specific elsewhere still doesn't get swept
  into everything else. Add deals, change a deal's
  status (Active, Sold, Dead, Under Contract, On Hold, or whatever
  categories you've defined), edit the **Address / City / State / Zip** at
  any time after creation (e.g. a typo, or details that firm up after the
  deal's already been added), manage exactly which reps can see each deal —
  including a one-click **Assign Myself To This Deal** / **Remove Myself**
  toggle so admin can mark themselves as personally on a deal too without
  hunting through the rep dropdown (it's purely an organizational marker,
  shown as "Admin (You)" in the chip list — it doesn't change admin's
  access, which is already unconditional) — assign it a **Deal Code** and
  **County**
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
  rep to ever see. Once a Source Link is set, a **Check If Still Live**
  button appears right there — it fetches that link and looks for the
  specific marker an InvestorLift listing shows once it's been pulled
  ("The property is not found"), and if found, automatically flips this
  deal's Status to Dead (never touches a deal already Sold or Dead). A
  **Check All Source Links For Dead Listings** button on the Deals tab
  runs this same check across every deal that has a Source Link and isn't
  already closed, in one pass, and reports how many it marked Dead. This
  is InvestorLift-specific and fragile by nature — it's matching on
  InvestorLift's current page markup, fetched with a browser-like
  User-Agent since their CDN otherwise blocks the request outright with a
  403. If InvestorLift changes that page, this check will need updating
  to match, and there's no way for the app to detect that on its own — a
  string match either finds what it's looking for or it doesn't. The
  Deals tab (both admin's and each rep's) also now has **Status** and
  **Asset Category** filter dropdowns above the list (plus a **State**
  filter on admin's side) — the same organize-by-category filtering
  Buyer Leads has long had, applied to deals too, on top of the existing
  free-text search.
- **Team** — every account also shows up here whether you created it or
  someone self-signed-up for it (see **Accounts &amp; Sign Up** above) —
  add/remove team members yourself too if you want, toggle "all-deal
  access" or admin rights per person, reset anyone's password. Each rep's
  row (including your own admin account) shows their **phone number**,
  **email**, self-identified **Type** (Buyer, Wholesaler, Realtor, Other,
  or blank for an admin-added account that never set one), **Deals They're
  Specifically Told To Work On** — every active deal they can currently
  work, whether that's because they're all-access, individually assigned
  to it, or have standing category access to it (see **Deals** above) —
  and **last active** (their most recent login) — a quick way to spot
  who's overloaded or who's gone quiet. **Edit Details** on a rep lets you
  set/update their phone, email, Type, preferred buyer-lead area — city and
  zip are still single values, but **states are now a comma-separated
  list** (e.g. "AZ, NV, CA"), so a rep who works multiple states can be
  matched across all of them instead of just one — and which **Asset
  Categories** they're specifically told to work: check one and they
  automatically get every deal in it, current and future, easy to
  change back any time right from this same modal. A separate **"Want to
  Join?" Contact** box at
  the top of the Team tab sets the name/phone/email shown on the login
  page for anyone without an account yet who's asking how to get set up
  with deals — it isn't tied to any real login, so you can point it at
  yourself, someone else, or swap it any time. That same email is also
  where **Forgot Password** clicks and a rep's **Request Address Access**
  land — one contact to keep current, not several.
- **Facebook Approvals** — every pending post request across all deals in one
  place, approve or reject with an optional note.
- **Buyer Matches** — every interested-buyer match across all deals in one
  place, so you can see at a glance who's Negotiating or Closing and pick up
  the conversation (rep's notes are visible to you the moment they're
  logged) to close the deal yourself, keeping the rep who brought the buyer
  updated as it moves.
- **Buyer Leads** — a collapsible **"How to Build a Buyer List"** guide sits
  above the importer for anyone new to this: find cash buyers on Propwire
  (Cash Buyers filter, plus Fix &amp; Flip or switch Property Type to Land
  depending on the deal, with Portfolio Value set to roughly 3x–20x the
  subject property's price, aiming for a master list of 500+ if the filters
  return that many), **split the export into batches of 100** (copy 100
  rows at a time into new CSVs until a 500+ list becomes 5+ separate files
  — work one deal's worth, 100 buyers, at a time rather than the whole
  thing at once), skip-trace each batch of 100 (free/manual at
  truepeoplesearch.com, a VA, Propwire's own paid skip trace, or a
  third-party vendor — **quickly**, since skip tracing itself doesn't make
  money, only calling buyers does), then come back and import the
  resulting CSV below. Closes with a volume target: **reach out to 50+
  buyers a day** to actually get a deal sold. It's a written walkthrough,
  not a live integration — Propwire and skip-trace steps happen on those
  sites directly. Upload a CSV file in any column order and it guesses
  which column is which (Name, Phone × 3, Phone Type × 3, City, State, Zip,
  County, Email, Asset Categories, Last Known Purchase Price, Estimated
  Value) from your headers, shows you a preview and the guessed mapping so
  you can fix anything it got wrong, then imports — or just paste rows
  directly if that's easier for a short list. Built to handle skip-trace
  exports (Propwire and similar) out of the box: a raw decimal like
  "21200000.000000000" becomes "$21,200,000"; if the amount and date of a
  last sale/purchase are in two separate columns, mapping both folds them
  into one "$X (date)" value instead of losing the date (and if the export
  only has a sale date with no amount — common on vacant-land records — it
  shows "Unknown price (sold date)" instead of a bare, easily-misread date).
  Propwire's own "Estimated Value" and "Estimated Equity" columns describe
  only the **one property in that row**, not the buyer's whole portfolio —
  Estimated Equity Percent folds into Estimated Value as "$X (Y% equity)"
  since 100% equity is a stronger "how liquid is this buyer" signal than
  the raw value alone (e.g. a good sign they could pay cash and close
  fast), but it never gets treated as portfolio-wide data. Propwire lets
  you *filter* a search by portfolio value but never exports the value
  itself, so **Portfolio Value** always comes from the **Portfolio Value
  For This Batch** min/max box on the import screen instead — enter the
  range you filtered on (or just a minimum) once and it's applied to every
  buyer in that upload, e.g. "$500,000 – $1,000,000" or "$500,000+". A
  **Which Deal(s) Is This List For?** checkbox list (optional, nothing
  checked by default) lets a rep tag the whole batch as pulled for one or
  more of their own deals at once — e.g. a buyer list built for land could
  match several North Carolina land deals, not just one. Grouped and
  sorted by State so a long deal list is easy to scan and skip past
  whichever ones don't apply, rather than one flat list in whatever order
  deals happened to be added — click any number of individual deals, no
  Ctrl/Cmd needed. Only deals the rep can actually see are offered, same
  list as their Deals tab, and it's re-checked on the backend so it can't
  be used to name a deal outside their access. It's purely a label (the
  same `PendingDealID` tag admin uses to earmark leads for a deal without
  creating a pitch, stored comma-separated so a lead can be earmarked for
  more than one deal) — it doesn't hand the buyer to anyone or create a
  pitch by itself, it just shows up on admin's Buyer Leads table
  (comma-listed if more than one) so admin can see which deal(s) a rep's
  private upload was meant for, and is filterable there via "Pending Deal
  Tag." Admin's own two import screens (CSV file and paste-rows, in the
  admin Buyer Leads tab) offer this same checkbox list, over every deal
  rather than just admin's own, since admin isn't access-restricted the
  way a rep is. **A Dead or Sold deal is never offered here or matched to
  any buyer at all** — buyer-matching (auto-feed, a rep's own "Match My
  Buyer Leads To This Deal," and admin's manual bulk-give) is blocked
  outright for a deal in either status, so nobody can accidentally get
  fed leads for a deal that's no longer sellable. If a lead tagged for a deal is later actually given to a
  rep as a real pitch for that same deal (see **Give Buyer Leads** /
  **Give / Tag Selected** below), just that one deal drops off its pending
  list — any other deal it's still earmarked for is left alone. A **My
  Buyer List** card right below the upload form shows a rep everyone
  they've personally uploaded — searchable by name/phone/city, with each
  buyer's tagged deal(s), a Notes field, and a Do Not Contact checkbox,
  editable right there regardless of whether that buyer has ever actually
  been matched to a deal yet. Previously a rep's own upload had nowhere to
  go afterward — the leads existed in the system but a rep could neither
  see nor touch any of it (not even mark a duplicate Do Not Contact)
  unless/until it happened to get matched to a deal and become a real
  pitch; a rep can now always view and edit anything they uploaded
  themselves, the same as admin can, on top of the existing "have an open
  pitch on this buyer" permission. A rep can also permanently **delete**
  any number of their own uploaded buyers from this same card — checkbox
  per row plus Select All/Clear Selection, a **Delete Selected** button,
  and a confirmation modal that requires typing **DELETE** (exact case)
  before the button even enables, since this can't be undone. Deleting a
  lead also removes any Pitches and call-log Contacts already made on it,
  so nothing dangling is left pointing at a buyer that no longer exists.
  This is strictly scoped to buyers that rep personally uploaded — never
  an admin-uploaded or another rep's private lead, even if its id were
  somehow included in the request; the backend re-checks ownership itself
  rather than trusting whatever the frontend sends, and ignores (rather
  than fails on) any id in the request that isn't actually this rep's own.
  The same checkboxes also feed a **Give Selected To This Deal** action
  right below — pick any deal a rep can see (including a brand new one
  added long after those buyers were uploaded) and hand-give the checked
  buyers to themselves for it, no auto-matching involved. Before this, the
  only way to connect an old uploaded buyer to a deal was the auto-matcher
  on the deal detail page (state/city/category match, or the city-override
  above), which only runs once at the moment it's clicked — there was no
  way to come back later and deliberately point one specific buyer at one
  specific new deal; this closes that gap. Also
  picks up an "Ownership Length (Months)" column (stored as a plain number
  so it stays filterable, shown as "19 yrs" wherever it's displayed) and a
  "Property URL" column (saved as-is, not shown in the preview table since
  it's long, but carried through to the buyer's profile); a Property Type
  column like "Multi-Family 5+ Units" is translated to this app's own Asset
  Category wording ("Multifamily (4+ Units)") so buyer-matching against a
  deal's Asset Category still works instead of silently never matching (an
  unrecognized category name just passes through as-is rather than being
  dropped); and listing-agent/lender/mailing-address columns are never
  auto-guessed as the buyer's own name/phone/email/location, since those
  belong to a third party, not the owner. Each buyer's profile also holds
  an editable Email, County, up to three phone numbers, Asset Categories
  (what they're looking for — Single Family, Condominium / Townhouse,
  Multifamily 4+ Units, Fix and Flip, etc. — customizable, see Asset
  Categories below), a price range they've told us they want (if known), a
  note on the last price we know they've actually paid for something
  similar, an **Estimated Value** (informational — current estimated value
  of one specific property we found they own, separate from their
  portfolio), a **Portfolio Value** (informational — total value of real
  estate we believe they own across their whole portfolio, a signal of how
  well-capitalized they are), an **Ownership Length** in months on that one
  property (informational — a long hold on vacant land often signals an
  inherited or otherwise low-priority parcel, worth flagging for
  dispositions outreach), and a Drive Link for their own documents (proof
  of funds, signed agreements) — visible to and editable by any rep who's
  been given that buyer, or by admin. A **Source Listing URL** back to the
  original Propwire (or similar) record is also kept on the lead, but it's
  admin-only — never sent to or editable by reps, enforced both in what the
  UI shows and on the backend itself (a rep can't write it even by calling
  the API directly). Portfolio Value also shows as its own column right in
  the table — both admin's Buyer Leads table and a rep's My Pitches list —
  so it's visible for every buyer at a glance without opening each one
  individually.
  Every contact a rep logs — and every "Interested Buyer" logged on a deal
  page — can optionally record what % of ARV or as-is value that buyer
  expressed interest at, building real data over time on what buyers
  actually pay relative to value. The table filters by Asset Category,
  State, **Cities** (comma separated, e.g. "Phoenix, Tempe, Mesa" — same
  convention as a deal's match cities) so a mass-select isn't limited to one
  exact city within a state, **Exclude Cities** to carve specific
  cities back out on top of everything else (e.g. State = AZ, Exclude
  Cities = "Phoenix" gets every Arizona buyer except Phoenix ones — handy
  when one city's already saturated), **Owner Type** (Companies Only —
  LLC/Inc/Trust/etc. in the name, tends to mean a more active investor —
  or Individuals Only), **Min Equity %** (pulls the equity number back out
  of Estimated Value to filter on, e.g. 100+ for cash-ready buyers who can
  close fast with no financing contingency), and **Held N+ Years** (using
  Ownership Length, to surface long-held/potentially-motivated owners) —
  every LLC/Inc/Trust-named buyer also gets a small "Co" tag right in the
  table for an at-a-glance read without opening the filter. Lets you select
  everyone on the page or the first N matching your filter (e.g. "give me
  50 Single Family buyers in Phoenix, Tempe, or Mesa"), and give that whole
  selection to one rep for one deal at once. Every filter, the sort, and
  pagination itself all run **server-side** — every search keystroke,
  dropdown change, or page turn asks the backend for exactly the ~50
  matching rows it needs, rather than downloading the entire list into the
  browser and filtering/paginating an ever-growing in-memory array (the
  original design, which got noticeably slower as the sheet grew past a
  few hundred rows since every keystroke re-filtered the whole thing
  client-side, on top of the initial page load shipping every row's every
  field regardless of what was actually visible). Typed filters (search,
  state, cities, exclude cities, min equity, min held years) wait briefly
  after you stop typing before reloading, so a fast typist doesn't fire a
  request per keystroke; dropdowns and checkboxes reload immediately since
  those only fire once per deliberate pick. "Select First N (Filtered)"
  fetches just the matching ids (not full rows) so it still works
  correctly across however many pages those N leads actually span,
  without needing to page through them by hand first; "Select All On This
  Page" only ever touches whatever's currently rendered, same as before.
  Every lead's row shows an
  **Uploaded** timestamp, and a **Sort** control (newest/oldest uploaded
  first) lets you browse chronologically by batch — handy for lining up
  "this deal went dead around such-and-such date" with whichever round of
  leads came in around then. Right after importing a batch, a **"Show only
  the N lead(s) uploaded [exact time]"** checkbox appears automatically so
  the fresh batch doesn't get lost among everything already in the sheet —
  select all of them and go straight to giving them out. When giving a
  selection to a deal, picking a team member is now optional — leave it on
  **"tag for this deal only"** to just earmark the selected leads for that
  deal without deciding who works it yet (nothing shows up in anyone's
  queue), then filter by **Pending Deal Tag** later to find them again and
  hand them to someone once you're ready — or pick a rep right away like
  before to give a real pitch immediately. A lead's tag clears itself
  automatically once it's actually given to a rep for that same deal. Give
  a buyer to a rep individually,
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
  want to open the spreadsheet." Duplicates (matched by phone or email —
  phone matching ignores formatting and a leading "1" country code, so
  "555-123-4567" and "+1 (555) 123-4567" are recognized as the same number)
  are never silently dropped or silently overwritten. When **admin**
  imports a row that matches an existing lead: if it has data that lead
  doesn't already have (a blank field getting filled in — never a
  conflicting overwrite of something already set), it's held back as a
  **Possible Duplicates With New Data** review right on the import screen
  — shows exactly what's new for each one ("County: Travis, Portfolio
  Value: $500,000+"), and you pick which to actually add, or dismiss the
  whole batch to skip all of them. A duplicate row with nothing new is
  just skipped automatically, no need to review it. For anything that
  slipped in before this existed — old imports, manual paste, or direct
  spreadsheet edits — **Scan for Duplicates** finds existing leads sharing
  a phone or email, groups them, and lets you pick which one to keep; the
  rest get folded into it (their pitches and full contact history move
  over — dropping only a pitch that would otherwise duplicate one the kept
  lead already has on the same deal — and any profile field the kept lead
  is missing gets backfilled from a duplicate that has it) and removed.
- Reps (anyone whose Type isn't Buyer, or a traditional admin-added account)
  get their own, simpler version of this same importer on their own Buyer
  Leads tab — same "How to Build a Buyer List" guide, same auto-detected
  columns, but no manual per-column override table. A rep's own upload is
  **private to them**: an **Uploaded By** column (this admin-only column
  only, never sent to any rep session, including the uploader's own) shows
  you who brought in each lead, and admin's Give actions and Auto-Feed will
  never hand a rep-uploaded lead to anyone but the rep who uploaded it —
  blank Uploaded By (admin's own imports) stays shared with the whole team
  like always. A rep is never blocked by a duplicate they can't even see
  (someone else's private list, or the shared pool) — their own row is
  always created regardless, tagged **Possible Dup** (another admin-only
  marker) so you can spot it later; a **Hide Possible Duplicates** filter
  on the Buyer Leads table lets you tuck those out of the way when you're
  reusing lists other people already uploaded. Both guides also warn
  explicitly against cold-texting a freshly skip-traced list — call first
  (with a voicemail if there's no answer); texting only unlocks once that
  person has actually responded to a call, same rule the rest of the app
  already enforces.
- **Pitches** — every open pitch across the whole team in one table, instead
  of having to open each buyer's detail panel one at a time. Search by buyer
  or deal, filter by team member or deal, and reassign or **Withdraw** any
  pitch right from the row — or select several (even across different reps
  and deals) and either **Withdraw Selected** to pull back a batch at once
  (e.g. everything a rep has on a deal that just went dead so they're free
  to pick up something new), or pick a team member and **Reassign Selected
  To** to mass-move a batch of pitches onto someone else in one action.
  Reassigning is a move, not a copy — if a selected pitch's buyer+deal
  already belongs to the person you're reassigning to, that one's dropped
  rather than duplicated. **More than one person can now be given the same
  buyer for the same deal** — handy when two reps cover the same market and
  you want a backup in case one isn't active — the only thing still blocked
  is the exact same person getting the exact same buyer+deal twice. "Give
  For a Deal" on a buyer's own detail panel works the same way: it now
  lists every active deal, even ones this buyer's already been given for,
  since giving it to a second person is a completely normal thing to do.
  Withdrawing only removes the pitch itself; that buyer's full contact
  history stays intact. Giving a buyer a pitch is now
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
