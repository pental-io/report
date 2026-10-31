<p align="center">
  <a href="https://pental.io/report">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
      <img alt="Pental Report: pentest reporting, on your own server" src=".github/assets/banner-light.png" width="100%">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/pental-io/report/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/pental-io/report?style=flat-square&color=b71c1c&label=release"></a>
  <a href="LICENSE"><img alt="Licence: AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-b71c1c?style=flat-square"></a>
  <a href="https://github.com/pental-io/report/pkgs/container/report"><img alt="Docker image" src="https://img.shields.io/badge/image-ghcr.io%2Fpental--io%2Freport-1f2433?style=flat-square&logo=docker&logoColor=white"></a>
  <img alt="Runs on macOS, Linux and Windows" src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux%20%7C%20Windows-1f2433?style=flat-square">
</p>

<p align="center">
  <b>Pental Report</b> is free, open-source penetration test reporting that runs on your own server.<br>
  Write findings with your team, draft them from your evidence with AI on your own key and your own prompts,<br>
  keep a library of them, and hand over a PDF or Word report in your firm's own brand.
</p>

<p align="center">
  <a href="#install">Install</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#a-look-around">A look around</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#what-it-does">What it does</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#ai-on-your-own-key">AI</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#your-reports">Your reports</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#updating">Updating</a>&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://pental.io/report">pental.io/report</a>
</p>

<br>

## Install

You need Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/) on a Mac or a Windows PC, or Docker Engine on Linux, which the installer offers to set up for you. Then run one command.

**macOS and Linux**

```sh
curl -fsSL https://pental.io/report/install.sh | sh
```

**Windows**, in PowerShell

```powershell
irm https://pental.io/report/install.ps1 | iex
```

The installer checks Docker, downloads the latest release, makes your settings with new secrets, and starts Pental Report beside its own PostgreSQL. Then it opens your browser on the first-run page with the setup code already filled in: you name your firm, make the first administrator account, set up your authenticator app, and you are in. Your logo, colours and theme are in Settings, Branding. It finishes like this:

```text
  ╭────────────────────────────────────────────────────────────
  │  Pental Report is installed.
  │
  │  Open         http://localhost:8080
  │  Setup code   prs_e40x9VW54Te-L4sAtPWb2p8OpqCBli4M
  │
  │  The setup code makes you its first administrator. It is also
  │  SETUP_TOKEN in /Users/you/pental-report/.env.
  ╰────────────────────────────────────────────────────────────
```

### For Your Team

**Over [Tailscale](https://tailscale.com)**, the simplest way. Install it on any computer in your tailnet, an office machine or a small server, and your team opens it from their own computers at that computer's Tailscale address, over HTTPS with a certificate Tailscale issues. Nothing is opened to the internet, and there is no domain or DNS to set up.

```sh
curl -fsSL https://pental.io/report/install.sh | sh -s -- --tailscale
```

```powershell
& ([scriptblock]::Create((irm https://pental.io/report/install.ps1))) -Tailscale
```

Sign the computer in to Tailscale first (on Linux the installer does it for you). The installer shares Pental Report with `tailscale serve` and finishes with the address, such as `https://reports-box.your-tailnet.ts.net`. Already installed for one computer? Run the same command and it is shared, with your data as it is. Your team needs to be on your tailnet (Tailscale's admin console, Users), and the computer needs to stay on. The first time, Tailscale may ask you to turn on HTTPS for your tailnet: it shows the link.

**On your own domain**, for a server anyone of yours can reach. Caddy serves it over HTTPS with a certificate it fetches and renews itself. Point the domain at the server first, with ports 80 and 443 open:

```sh
curl -fsSL https://pental.io/report/install.sh | sh -s -- --domain reports.yourfirm.com
```

Either way, the address your team types is `PUBLIC_URL` in `.env`, and the installer fills it in. Pental Report makes the links it hands you (to set a password) with it, and a security key works only at that one address, over HTTPS.

<details>
<summary><b>Installer options</b></summary>
<br>

| macOS and Linux | Windows | |
|---|---|---|
| `--tailscale` | `-Tailscale` | Share it with your team on your Tailscale network, over HTTPS |
| `--domain NAME` | `-Domain NAME` | Serve it over HTTPS at NAME |
| `--local` | `-Local` | This computer only, at `http://localhost` (the default) |
| `--dir PATH` | `-Dir PATH` | Where it lives: `~/pental-report`, or `/opt/pental-report` when run as root |
| `--version X.Y.Z` | `-Version X.Y.Z` | A particular release rather than the latest |
| `--yes` | `-Yes` | Ask nothing and take the defaults |
| `--no-open` | `-NoOpen` | Leave the browser closed at the end |
| `--no-auto-update` | | No updater: you run the install command when a release is out (see [Updating](#updating)) |

On Windows, give it options like this:

```powershell
& ([scriptblock]::Create((irm https://pental.io/report/install.ps1))) -Domain reports.yourfirm.com
```

</details>

<details>
<summary><b>Installing by hand</b></summary>
<br>

Download the latest release from [Releases](https://github.com/pental-io/report/releases/latest), unzip it, and in that folder:

```sh
./setup.sh                # .\setup.ps1 on Windows
docker compose up -d
```

Setup asks for a domain (leave it blank to use it on this machine at `http://localhost:8080`), makes `.env` with new secrets and prints the setup code. Open the address it printed and enter the code.

To share one made this way over Tailscale: `tailscale serve --bg http://127.0.0.1:8080`, then set `PUBLIC_URL` in `.env` to the address it prints and `TRUST_PROXY=1`, and run `docker compose up -d`.

</details>

## A Look Around

Every picture here is the app itself, with an invented firm's engagement in it. The firm's logo, colours and fonts are its own, set in Settings, Branding.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/findings-dark.png">
    <img alt="An engagement's findings, by severity, in the firm's own colours" src=".github/assets/screens/findings-light.png" width="100%">
  </picture>
  <br><sub>An engagement's findings</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/finding-dark.png">
    <img alt="A finding with its description, the firm's own Business Impact field, remediation and evidence" src=".github/assets/screens/finding-light.png" width="100%">
  </picture>
  <br><sub>A finding, with a field of the firm's own</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/client-dark.png">
    <img alt="A client's page: their contact, the engagements for them and the findings still open" src=".github/assets/screens/client-light.png" width="100%">
  </picture>
  <br><sub>A client, with their engagements</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/calendar-dark.png">
    <img alt="The testing calendar: each tester's week in a row of their own, and an engagement waiting for a lead" src=".github/assets/screens/calendar-light.png" width="100%">
  </picture>
  <br><sub>The testing calendar</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/fields-dark.png">
    <img alt="Settings for finding fields: rename, reorder, require, reuse and add your own" src=".github/assets/screens/fields-light.png" width="100%">
  </picture>
  <br><sub>Finding fields, set up the way the firm writes</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/branding-dark.png">
    <img alt="Branding settings: accent colour, severity colours, theme colours and a logo for each theme" src=".github/assets/screens/branding-light.png" width="100%">
  </picture>
  <br><sub>The firm's logo for each theme, its colours and its severity colours</sub>
</p>

## What It Does

**Engagements**

- **Your clients**, each with their contact and their engagements, and a new engagement started from a client's page.
- **A testing calendar.** Each tester's engagements week by week, and the ones still waiting for a lead, given one from there.
- **Every engagement in one list**, with a reference code for each (numbered your way, or random), a type from your own list, its dates, test days, perspective and lead tester. Rename, duplicate, archive and restore, or delete. An engagement is open from the moment it is made, with no status to move along: its report downloads whenever you like.
- **Phases.** External, internal, web, retest or whatever shape the work takes, each with its own type, scope, test days and retest setting.
- **Checklists and runbooks on each phase.** A methodology library of 22 checklists to start from, searched by name and narrowed by category, each previewed before you add it: OSSTMM 3, PTES, NIST SP 800-115, OWASP (ASVS 5.0, the API Security Top 10, the Top 10 2025, the LLM Top 10 2026 and the IoT Security Testing Guide), MITRE ATT&CK, PCI DSS 11.4, Active Directory, Kubernetes, thick clients, red team, social engineering and physical. Six of them are suggested on a phase of their type: web application (OWASP WSTG), internal infrastructure, external infrastructure, cloud, mobile (OWASP MASVS) and wireless. Write your own too: tick items as you test, with who ticked each and when if you want it, and follow a runbook's steps with each command a click to copy. Bring them in or take them out as Excel, Word or JSON, in **Settings, Checklists & Runbooks**.
- **On each engagement:** its notes, scope, the artifacts left on the client's systems, caveats, appendices for the report (screenshots, tool output, scan results and the rest), files such as videos, and comments for your team.
- **Sections your way.** Rename, reorder, give an icon to, switch off or leave out of the report any built-in section, and add your own in the ten field styles.

**Findings**

- **Fields your way.** Rename any built-in field, hide the ones you do not use, decide which are required, which carry across from the library, and their order. Add fields of your own in ten styles: rich text, plain text, a single line, a short value, a number, a date, a dropdown with colours, multiple choice, yes or no, and a link.
- **Draft and final.** A finding is a draft until its required fields are filled, and you choose which new findings start as.
- **A full editor.** Bold, italic, underline, colours and highlights, lists, alignment, links, tables, inline code and code blocks, and page breaks, with a clean paste from Word that keeps your formatting. Screenshots, requests, tool output and tables in the evidence, every figure numbered and captioned.
- **CVSS 3.1 and 4.0**, built from its metrics so the score and the vector always agree, with the severity set by the score or by hand. CWE, your own categories, affected assets chosen from the engagement's scope, and references.
- **Retests.** Mark findings for retest, record each result as remediated, part remediated, not remediated or risk accepted, and write the retest summary. All of it goes into the report.
- **Every finding in one place**, across all your engagements, sorted, selected and edited from one list.
- **A findings library.** Save a finding once and reuse it with exactly the fields you choose. Typing a title searches it, Import from Library brings entries into an engagement, and it can take every new finding by itself and keep its wording up to date from findings you rewrite.

**AI**

- **On your own key or your own hardware**: Generate all from evidence, a button on every field, instructions for any field, the summaries and the Document Builder, each from a prompt you can rewrite. [AI on Your Own Key](#ai-on-your-own-key) has all of it.

**Reports**

- **The built-in PDF**: your cover, a contents page, a version history, a severity summary and chart, every finding, your appendices and your footer.
- **Your own Word templates**, with the Draft, the Document Builder and the Placeholder Key. See [Your Reports](#your-reports).
- **The same document every time.** The same engagement renders the same file, so this quarter's report sits beside last quarter's cleanly.
- **Dates and file names your way**: how dates are written in documents, and the name of each kind of file Pental Report makes.
- **Download** a report from the list of engagements, or, as an administrator, every report at once from Settings, Data, as a ZIP of PDFs.

**Exports and imports**

- **Findings to Excel, PDF or Word**: one finding, an engagement, or every phase at once (one Excel file with a tab per phase, or one PDF). Choose the columns, and add a summary tab with the severity counts per phase and a figures tab that indexes every figure with a link back to its finding. Word exports use your own findings template.
- **An edited sheet back in.** Export findings to Excel, change them there, and bring the sheet back: Pental Report shows what would change and what would be deleted before anything is.
- **Back up and restore.** Your records and uploaded files in one file, from Settings, Data, which restores here or in Pental.

**Your brand**

- **Your look.** A logo for each theme and a favicon, your accent, severity, alert and text colours, how reference codes look, and your fonts for headings, text and code. Severity colours can be copied from your PDF report template. Dark, light, or both with a switch for each person.
- **Your sign-in page.** Its title, heading, subtitle, support email and footer, with your logo and name shown or not.
- **Your company and testing IPs**, carried onto your reports.

**Your team**

- **Roles.** Administrators, senior testers and testers, each able to see and do what their role allows, checked by the database on every read and write.
- **People.** Add a colleague, change their address, send setup links, and reset a lost authenticator. Each person has a profile with a picture, job title and phone, for the reports that name them.
- **A second factor for everyone**: an authenticator app, or a security key or passkey once it is served over HTTPS. Choose which are allowed or require both, when people prove it again and how long a session lasts, and see active sessions and sign the others out. See [Security](#security).
- **Live together.** What a colleague saves appears for everyone at once, and two people saving the same finding are asked before one overwrites the other.

## AI on Your Own Key

The AI drafts from the evidence your testers capture, in your firm's own words, and everything it writes lands in the editor as a draft for a tester to keep, rework or discard.

- **Generate all from evidence.** Paste your notes, tool output, requests, tables and screenshots as rough as they were taken, and one action turns them into a finished finding. It explains each piece of evidence and captions every screenshot, rewrites your notes as report prose with every value kept and the to-dos left out, names the finding and brings in your library's wording where you have written the weakness up before. Then it drafts the description, remediation, CVSS vector, CWE, category, affected assets, your own fields and the references, each step using what the ones before it wrote. What is already written stays as it is, and one undo puts everything back.
- **Explain evidence** on its own: a line above each screenshot, request, block of code, output or table saying what it shows, and a caption under each screenshot.
- **A button on every field.** Classify picks the category from your own list, Calculate works out the CVSS vector, the CWE is classified, Generate writes the description, remediation and your own fields, the affected assets are chosen from the engagement's scope and evidence, and the references are found. Redo one part and keep the rest.
- **Tell a field what to change.** Add your own instructions to any field, or pick Shorter, More detail or Plain English. Only that field is rewritten, one click puts it back, and the instructions you keep are offered again next time.
- **Summaries and sections.** The executive summary and the retest summary are drafted from the findings in the assessment, in the structure you set, and sections of your own are drafted from prompts of their own. Retest evidence is explained the way a finding's is.
- **The library too.** A library entry is drafted the same way, from its title.
- **The Document Builder.** Upload a report you already send, and the AI places each placeholder where it belongs for you to check and save, so the report becomes your Word template.

### Your Own Prompts

Every field and section the AI writes, built-in or your own, has a prompt of its own, under **Settings, Findings** and **Settings, Assessments**. Rewrite them in your firm's voice: how a description opens, what a remediation covers, how much detail a summary gives. **Reset to default** puts the built-in prompt back. What the AI is asked is always what you can read there.

### Your Provider, or Your Hardware

- **Anthropic, OpenAI or Groq**, on your own account and key, or **any OpenAI-compatible or Anthropic-compatible endpoint** you host or trust, with custom headers where it needs them. Choose the model, how many requests a minute it is sent and how many fields are written at once, and for your own endpoint its format and token ceiling.
- **Ollama, on your own hardware**, on each tester's computer or on one server for the team. Your browser talks to it, so prompts and evidence stay on your network. **Settings, AI** has a setup guide for both, including a shared server over Tailscale or your own VPN.
- **Test Connection** tries it before you rely on it.

Your key is kept encrypted in your own database, and your own Pental Report server sends each request to the provider you chose.

## Your Reports

Every engagement becomes a report two ways, both in your own brand.

**The built-in PDF**, styled from Settings: your logo and colours on the cover, a contents page, a severity summary and chart, every finding, and your appendices.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/report-dark.png">
    <img alt="The built-in PDF: cover, findings summary and a finding" src=".github/assets/screens/report-light.png" width="100%">
  </picture>
</p>

**Your own Word template.** Upload a `.docx` under Settings, PDF & DOCX, and every report is your template filled in, as a Word document, with the PDF made from it in your browser if you like. Start from the **Draft**, a ready-made template in your colours with every placeholder in it, including your own fields, or let the **Document Builder** turn a report you already send into one. The **Placeholder Key** lists everything you can place.

**Edited in Word, brought back.** Download the report as your Word file, edit it in Word or send it round for review, and upload it back beside the report's button. Pental Report shows what changed before anything is written: plain edits and tracked changes (each one yours to accept), and Word comments, which join the engagement's Comments saying who wrote them and where. The file you upload can then be the report your team downloads, kept up to date with anything changed since.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/word-dark.png">
    <img alt="A report made from the firm's Word template: cover, findings summary and a finding" src=".github/assets/screens/word-light.png" width="100%">
  </picture>
  <br><sub>The firm's Word template, filled in</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/screens/templates-dark.png">
    <img alt="Settings, PDF and DOCX: the firm's Word template, the Document Builder, the Draft and the Placeholder Key" src=".github/assets/screens/templates-light.png" width="100%">
  </picture>
  <br><sub>Where the template is kept</sub>
</p>

## Updating

Pental Report tells its administrators when a new release is out, in **Settings, Updates**, with what the release changes, and in a banner at the top of the page when there is something to do about it. Where it updates itself, nothing is said until the new release is in.

**By itself, on Linux and macOS.** The installer sets up a small updater on the computer Pental Report runs on (`update.sh`, run by a systemd timer on Linux and a launchd agent on macOS). A new release then installs overnight, between 1am and 6am on that computer's clock, or straight away when an administrator presses **Update Now**. Before each one the updater copies the database to `backups/` (the last three are kept), installs the release from its own tag on GitHub, and puts the version before it back if the new one does not start. What it did is in `update.log` and in Settings, Updates. With automatic updates turned off there, a release installs only when you press Update Now; the installer's `--no-auto-update` sets up no updater at all.

**With one command, anywhere.** Run the install command again: Settings, Updates gives it for your computer. It downloads the new release and restarts Pental Report, and your settings (`.env`) and your data stay as they are. Pental Report brings its database up to date when it starts. On Windows, this is how it is updated.

## Backups

The simplest is in the app: **Settings, Data, Back Up Your Data** downloads one file with your records and uploaded files, which Pental Report or Pental can restore.

From the server, in the folder Pental Report lives in:

```sh
docker compose exec -T db pg_dump -U postgres report > report-$(date +%F).sql
```

Keep `.env` with your backups. `VAULT_KEY` in it seals this server's signing keys in the database, and the server will not start on a copy of the database without it.

<details>
<summary><b>Restoring a database backup</b></summary>
<br>

On a fresh install with the backup's `.env` in place (or the same server):

```sh
docker compose stop report
docker compose exec -T db psql -U postgres -c "DROP DATABASE report WITH (FORCE)" -c "CREATE DATABASE report OWNER report"
docker compose exec -T db psql -U postgres -d report < report-2026-10-29.sql
docker compose start report
```

</details>

## Settings

Everything you can set is in [`.env.example`](.env.example): the address, where it listens, file storage in an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, Backblaze B2), the largest upload, and logging. Change `.env`, then run `docker compose up -d`.

## Locked Out

An administrator makes a colleague a new password link from Team, and resets a lost authenticator there too. When the person locked out is the only administrator, whoever runs the server does it, in the folder Pental Report lives in:

```sh
# A link to choose a new password (it works once, for an hour)
docker compose exec report node server/bin/password-link.js you@yourfirm.com

# Clear a lost authenticator or security key: a new one is set up at the next sign-in
docker compose exec report node server/bin/reset-mfa.js you@yourfirm.com
```

## Your Data

Everything lives in the PostgreSQL that runs beside Pental Report: assessments, findings, your library, settings, templates and uploaded files (or your own S3-compatible bucket). Nothing is sent to Pental.

Two things are fetched from outside when you use them: the AI provider you choose, and the Word-to-PDF engine (from `cdn.zetaoffice.net`) when you make a PDF from a Word template. The conversion runs in your browser, and your document is not uploaded anywhere.

To know of a new release, the server asks GitHub for Pental Report's latest one twice a day. The request carries nothing but the version it runs, and `UPDATE_CHECK=off` in `.env` stops it. An update is downloaded from GitHub too.

## Moving to Pental

[Pental](https://pental.io) is all of Pental Report, and what it takes to sell pentesting as a service, under your brand:

- **Pentest as a service.** Clients sign in to a portal on your own domain to read their findings, ask for retests and comment on the engagement, during it and long after it.
- **Live reporting.** Show a finding to the client the day you confirm it, marked as a draft until it is written up, and nothing unfinished goes into the report.
- **QA before anything goes out.** One review queue, your own checklist, comments and suggested edits on the words themselves, and an optional AI reviewer.
- **Credentials.** Clients send their test credentials encrypted, for your lead tester to view once, and are reminded by email before an authenticated test starts while theirs are still outstanding.
- **And the rest.** Attestation letters, findings pushed to your clients' Jira, ServiceNow and other trackers with their state read back, and scanner output imported as findings.

**Move to Pental**, at the foot of the sidebar, walks you through it: download everything from Pental Report (one .zip), start a Pental trial, and upload the .zip in your new portal: its setup asks for it at Bring Your Data Across, and Settings, Data has it too. Before anything is written you choose what comes across: your team, each new person invited by email, added without one, or left out; your clients, assessments and findings; the library and checklists; and whether your branding, fields, sections, prompts and Word templates replace the portal's or sit beside them. What comes across arrives as it is.

## Security

Every person signs in with a password and a second factor: an authenticator app, or a security key or passkey once Pental Report is served over HTTPS. Passwords are hashed with bcrypt. Row-level security in PostgreSQL checks every read and write against the person's role and a recent second factor. Your AI key is kept encrypted in the database, and this server's signing keys are sealed with `VAULT_KEY`.

Found a vulnerability? Please see [SECURITY.md](SECURITY.md).

## Building From Source

```sh
docker build -t pental-report .
```

Or without Docker, with Node.js 22 and PostgreSQL 16 or later: `node web/build.mjs`, then `node server/server.js` with the settings from `.env.example` in its environment.

- `server/` is a small Node.js server: the app, a PostgREST-compatible API under the database's row policies, sign-in, file storage, live updates over a websocket, and the AI relay. Its only dependencies are `pg` and `ws`.
- `web/` is the app. `web/src/engine.js` is Pental's own reporting code, made from Pental's portal for each release; `web/src/shell/` is what runs it on its own server. Change the shell rather than the engine.
- `db/` is the database, applied when the server starts.

## Licence

Pental Report is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version for others to use over a network, you must offer them its source. Copyright Pental Limited.
