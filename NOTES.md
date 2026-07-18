# Eastlake Scheduler — Future Feature Notes

This document collects design notes for planned/future work, not yet implemented.

## 1. System Redesign — Roles, Auth, Availability, Escalation

### Core Hierarchy
Admin (Ted) oversees Directors (one per city program), who oversee Coaches (one per team).

### User Roles and Permissions
Three access tiers:
1. Public viewing
2. Logged-in but not authenticated (view schedules, contacts, etc.)
3. Fully authenticated (make changes, send messages)

Directors can act on behalf of their coaches. Admin can act on behalf of any director. This preserves accountability while allowing delegation when someone drops the ball.

### Authentication
Email address is the identity/login. Magic link or PIN code sent to email for verification — lightweight security, not high-stakes, but verifiable.

### Team Registration Process
- Directors get invited/onboarded first, creating accounts for their city program.
- Directors then submit teams and coach info for their city.
- Coaches choose their home field from a list the director has entered.
- Divisions assigned by age and gender (e.g., U10 Boys, U10 Girls, U12 Boys, U12 Girls, U15 Coed).

### Availability System — Two Independent Layers
1. **Coach availability** (schedule-based, per team):
   - Monday–Thursday: single time slot per day — available or not.
   - Saturday: three blocks — before 11am, 11am–2pm, 2pm–5pm (approximate).
   - Each slot marked as one of: not available / available to host / available to travel / available for both.
   - This reflects the team's schedule constraints, not field access.

2. **Director field availability** (per program):
   - Directors toggle on/off which fields are available to host, by day/time block.
   - Separate step from coach availability — coach saying "available to host" doesn't guarantee a field is open; the director's field toggle confirms that.

### Scheduling Engine
- Fully automated — matches games based on both layers of availability (a game requires: two teams both available, plus a host field available).
- Already built and working well from last season.
- New this year: travel distance balancing. Each team has a declared home field; the engine will factor in distance between home field and away field to balance travel load across the league.

### Escalation Workflow (for schedule change requests between coaches)
- Coach A requests a change involving Coach B (different program).
- If Coach B doesn't respond within a set window (e.g., a couple days), Coach B's director gets looped in to help move things along.
- If still unresolved after further time, Admin (Ted) gets alerted, along with a note to Coach A that the request hasn't been addressed.
- This isn't for every change — normal changes stay between coaches. Escalation only kicks in when something stalls.

> **Relationship to §2 below:** §2's Game Change Confirmation Flow is a more detailed, earlier design for the coach-to-coach half of this same escalation problem (request → confirm → approve/reject, with a 2-day timer to admin). This section adds the **director** as an intermediate escalation step before admin. When implementing, reconcile the two: likely Requesting coach → Other coach → **Other coach's director** (new) → Admin, rather than jumping straight from coach to admin.

### Director Invitation & Onboarding
1. Admin adds a director in the admin panel: name, email, city/program.
2. System emails a magic link to activate.
3. Director clicks link → account active, scoped to their one city/program.
4. **Field setup (required before team registration):** director enters/manages the list of fields available to their program (name, location). This is the list coaches pick their home field from, and what the director's field-availability toggles (§1 above) operate on later.

### Team Registration (director-driven)
- Director adds each team: team name/label, coach name, coach email, coach phone, home field (from the field list), division (age/gender).
- System auto-creates the coach's account behind the scenes (magic-link based) — coach never does a separate signup, but can log in later for availability entry, change requests, etc.
- **No separate "confirm" step** — a team is good to go as soon as the director finishes entering it. (Context: last year's registration was a mess because Ted inherited a half-started setup and had to fix it after the fact. This year is a clean start, so there's no backlog of partial/messy entries to gate behind a manual confirm step — get it right at entry time instead.)

### Editing Info After the Fact
- Expect frequent changes throughout the season — this is normal, not an edge case.
- **Coaches can edit their own info** (including email), and **directors can edit it on a coach's behalf** too.
- **Email changes require verification**, since email doubles as login identity: saving a new email sends a magic link to the *new* address, and the change only takes effect once that link is clicked. Prevents a typo from locking someone out, and stops someone from silently reassigning a coach's login. This applies whether the coach changes their own email or a director changes it for them.

### Open / To Revisit Later
- Notification behavior when a director makes a change on a coach's behalf (likely just a heads-up notification).
- Handling teams with access to more than one home field (may simplify to a yes/no "can host" rather than tracking multiple fields).
- Tech stack and implementation details — deliberately deferred for a later session.

---

## 2. Game Change Confirmation Flow (detailed sub-design)

### Game Status Lifecycle
```
Scheduled → Pending → Confirmed → Finalized
```
- **Scheduled** — default state after schedule is generated
- **Pending** — only triggered when a change is requested AND the requesting coach confirms via magic link
- **Confirmed** — receiving coach approves the change via magic link
- **Finalized** — admin finalizes (admin moves all games to Finalized when the deadline hits)

Pending is visible to all coaches. If no change is ever requested, a game goes straight Scheduled → Finalized.

### Full Change Request Flow
1. Any coach submits a change request (anyone with a registered email can initiate)
2. **Email → requesting coach** — "Did you mean to request this?" with Confirm / Cancel links
3. If **cancel or ignore** → nothing happens, schedule unchanged, no Pending shown anywhere
4. If **confirm** → game moves to Pending, **email → other coach** with Approve / Reject links
5. Other coach **approves** → game moves to Confirmed, requesting coach is notified
6. Other coach **rejects** → change declined, requesting coach is notified
7. Other coach **ignores** → escalates per the timeline below (director, then admin)
8. If a magic link is clicked after the change is already resolved → show "this has already been resolved" page

### Escalation Timeline (requires 7+ days' notice to use this flow at all)
- **Day 0** — request submitted
- **Days 1–2** — window for the other coach to respond (Approve/Reject)
- **Days 3–4** — no response → escalates to the other coach's **director**
- **Days 5–6** — still unresolved → escalates to **admin**
- **Day 7** — originally scheduled game date; must be resolved by now
- Calendar days, not business days (weekends count)

### 7-Day Lockout + Manual Override
Requests inside the 7-day window **cannot** go through this flow — the game is locked out of the normal request/approval process entirely. Any change within 7 days must be arranged by phone directly with the other coach.

- The "request change" button remains visible for locked games, but clicking it shows the cutoff explanation plus the other coach's phone number — it does not start the normal flow.
- A separate, clearly-labeled **Manual Override** button appears alongside that message, with instructions that it's only to be used *after* confirming the change with the other coach directly.
- Using Manual Override requires the requesting coach to enter **who they spoke to** and **how they connected** (phone call, text, etc.) before the change can be submitted.
- On submit: the game is changed immediately (no Pending/approval wait, since agreement already happened outside the system). A notification is sent to the **other coach and both directors** (not admin) — including the who/how confirmation details, as the accountability record.
- Admin is intentionally **not** copied on manual overrides — this is a director-owned accountability mechanism, not an admin oversight one.

### Authentication Approach
- No passwords for coaches
- **Login** (viewing schedule/contact info) — email lookup only; low-stakes, just gates info from the public web
- **Game change actions** — magic links sent to registered email; clicking the link proves email ownership and serves as authentication for that specific action

### Notes
- Coaches should be informed in advance that they have 2 days to approve/reject a change or it escalates (to director, then admin per §1)
- Admin can always override regardless of where things stand
- All of this fits the existing Node/Express + stateless JSON + Resend stack — no database needed
