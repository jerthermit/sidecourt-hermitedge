# GitHub publication

## Repository fields

| Field | Value |
| --- | --- |
| Repository | `jerthermit/sidecourt-hermitedge` |
| Default branch | `main` |
| About | Pickleball control room for check-in, court rotation, live player boards and session reports. |
| Website | [sidecourt.hermitedge.com](https://sidecourt.hermitedge.com) |
| Topics | `pickleball`, `club-operations`, `sports-software`, `react`, `typescript`, `fastify`, `sqlite` |
| Source rights | All rights reserved |

## Import the clean source

Use the reviewed source ZIP. If the destination already has commits, clone that destination and copy the archive contents into its working tree. Keep the private deployment checkout's Git history and runtime files out of the public repository.

For an empty destination, extract the ZIP, open the `sidecourt-hermitedge` folder and run:

```bash
git init -b main
git add .gitignore README.md backend docs frontend
git diff --cached --check
git diff --cached --name-only
git commit -m "Publish Sidecourt public edition"
git remote add origin https://github.com/jerthermit/sidecourt-hermitedge.git
git push -u origin main
```

Review the staged file list before committing. Keep filled environment files, credentials, databases, client exports, private records and deployment state outside the public repo. Confirm disclosure rights and check the Code tab before switching visibility. The live app uses its existing deployment repository.

## First release

Draft the release on the approved public commit. Use tag `v1.0.0` and title **Sidecourt v1.0.0 — Public Edition Release**. Mark it as the latest release after reviewing the source downloads. [GitHub release guide](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

> Sidecourt gives pickleball hosts one place to check players in, review rotations and run matches.
>
> - Mapped roster CSVs and configurable clubs with up to 16 named courts.
> - Reviewed court assignments and a read-only player screen for courts and queues.
> - Session and daily reports chart match starts and court time. Session reports show games per player and export attendance and matches.
>
> The public edition uses fictional club records. [Open Sidecourt](https://sidecourt.hermitedge.com)

GitHub provides ZIP and tarball downloads for the tagged commit. The frontend and backend ship from source with their own lockfiles. GitHub Packages can stay empty because there is no separate library or container to install.
