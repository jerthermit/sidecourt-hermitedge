# Sidecourt

Commissioned for an Australian pickleball club and later adapted for the Philippines. The public edition demonstrates the workflow with fictional records.

## Before and after

Players used Reclub and other booking platforms. Once they arrived, club staff used a whiteboard to track who had checked in, who was waiting and which groups were on court. A late arrival, a break or an incorrect match entry meant another manual update.

Emman built a roster, waiting queue, court board and read-only player screen around one session record. The host can check players in, account for breaks and late arrivals, review teams and run each court. Players can follow their queue position on a separate screen. Staff can correct a match with a reason and export the session report at close.

## What the clubs commissioned

The engagement covered club configuration, roster migration, the tailored host workflow, operator training and ongoing support. The second engagement adapted the workflow for a different club context. Sidecourt took over the courtside whiteboard while the clubs kept their existing booking platforms.

## Engineering

The Fastify API owns attendance, timing and court state in SQLite. The host approves a deterministic rotation before assigning players. An outdated review is rejected, and a multi-court assignment commits together. Voids and corrections retain their reasons and recalculate reports. Roster imports use a stable source and player ID, so a returning member keeps their history.

The public application supports 1–16 named courts and mapped roster CSVs. Reports show recorded activity by session and venue-local day. Client identities, commercial terms and private records remain confidential.

[Public edition](https://sidecourt.hermitedge.com) · [Operations guide](operations.md)
