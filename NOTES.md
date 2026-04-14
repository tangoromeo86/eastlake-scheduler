# Eastlake Scheduler — Future Feature Notes

## Game Change Confirmation Flow

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
7. Other coach **ignores for 2 days** → admin is emailed with same Approve / Reject links (admin has final say)
8. If a magic link is clicked after the change is already resolved → show "this has already been resolved" page

### Authentication Approach
- No passwords for coaches
- **Login** (viewing schedule/contact info) — email lookup only; low-stakes, just gates info from the public web
- **Game change actions** — magic links sent to registered email; clicking the link proves email ownership and serves as authentication for that specific action

### Notes
- Coaches should be informed in advance that they have 2 days to approve/reject a change or it escalates to the admin
- Admin can always override regardless of where things stand
- All of this fits the existing Node/Express + stateless JSON + Resend stack — no database needed
