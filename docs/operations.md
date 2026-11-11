# Operations and data boundaries

## Roles and authority

The host manages the session. The backend owns court state, eligibility, timing, attendance and corrections. Private mode uses one operator credential. A temporary player-screen link can read courts, staged groups and queue positions for that session.

Bookings, membership, payments and official ratings stay in their existing platforms. Sidecourt accepts a prepared CSV and manual arrivals. Live provider synchronization is outside this edition.

The API rejects unlisted browser origins, applies input and rate limits, and sends no-store responses. A display credential cannot mutate a board or read reports. Keep operator keys and display links out of logs and recordings.

## Roster and check-in

Use a stable source label and player ID. Map CSV headers and preview the rows before import. Source labels are trimmed and matched without case. Player IDs are case-sensitive. A known member who joins a new session retains their identity and waits for check-in.

Profile changes require explicit approval of the saved and incoming values. A stale review, invalid row or ambiguous identity rejects the import. Existing attendance and match records are retained. Omitted rows do not withdraw players. Keep ratings blank when they are unknown.

New sessions start empty unless the host chooses **Use previous roster**. Hosts record arrival, rest, return and departure. Search and page size affect what is shown. Queue position refers to the complete waiting list.

## Court rotation

The venue configures singles or doubles, 1–16 named courts, open or skill-banded rotation and partner variation. End active matches before editing club settings. Empty a court before removing it. Historical names stay in past records.

The planner selects eligible players in queue order, then arranges teams using known ratings and completed partner and opponent history. For larger venues it plans consecutive cohorts of up to six courts. In skill-banded play, an incomplete oldest band can block subsequent assignments. A host must explicitly approve a mixed-level exception.

Review a group before assigning it. Approval checks the current session revision, player eligibility and court availability, then commits all reviewed moves together. A stale or expired review must be refreshed. Assignment does not start a match. Staging does not reserve a court. The rotation rules run locally on the API with no external model call.

## Match records and reports

Use **End only** to complete a match or **End & review** to also prepare the next group. If review preparation fails, the completed game is already recorded. Retry through **Review group**. Void an accidental start to retain the group without adding a completed match. Corrections and voids require reasons. Closed sessions are read-only.

Session reports show attendance, completed play, court time and the distribution of completed games among checked-in players when identities are complete. Day reports use the current venue time zone and distinct first check-ins. A match belongs to its local start date, even when it crosses midnight. Corrected records use their latest values. Active matches and voids do not add completed court time. Court time measures recorded play.

The player screen refreshes every five seconds. It shows names, courts and queue positions. A position is not an estimated start time. A disconnected screen shows the last confirmed snapshot until access expires.

## Storage and handover

Each public visitor gets an isolated, temporary board with fictional players and populated reports. Use the host's player link to follow that same board on another device. A new visit creates a separate board, and a backend restart clears public sessions.

Club settings exports contain configuration and column mapping. Importing fills a draft for the host to save. For a private database, use a consistent SQLite backup or quiesced volume snapshot. Test restoration before upgrading. [Deployment and recovery](deployment.md)

Keep roster reconciliation, host training, acceptance, commercial terms and support arrangements in the private handover.
