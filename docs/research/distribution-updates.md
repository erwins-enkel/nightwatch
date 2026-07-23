# Research: Distribution & Updates

**Ticket:** #4 (Wayfinder-Research) · **Teil der Map:** #1
**Frage:** Wie wird Nightwatch verteilt und aktualisiert?
**Rahmen:** Open Source, öffentliches GitHub-Repo + öffentliche Registry `ghcr.io`.

---

## TL;DR / Empfehlung

**Basis-Distribution: Ein gepflegtes `docker-compose.yml` im Repo-Root** (plus `.env.example`) ist der kleinste gemeinsame Nenner und läuft auf jedem Docker-Host, DigitalOcean-Droplet, Portainer, Synology usw. Alles Weitere baut darauf auf.

**Kanäle (nach Aufwand gestaffelt):**

1. **Phase 1 – Compose-Template (sofort, quasi kostenlos).** `docker compose up -d` gegen ein Image `ghcr.io/kai-osthoff/nightwatch:vX.Y.Z`. Copy-Paste-README. Kein Review, keine Abhängigkeit von Dritten.
2. **Phase 2 – Portainer App Template (v3, geringer Aufwand).** Eine `templates.json` (Typ `3` = Compose-Stack) wird als **Raw-URL aus dem eigenen GitHub-Repo** gehostet; Nutzer tragen die URL in Portainer ein und deployen mit einem Klick. Kein Portainer-seitiger Freigabeprozess nötig.
3. **Phase 3 – DigitalOcean Marketplace 1-Click Droplet (höchste Reichweite, höchster Aufwand).** Packer-gebautes Droplet-Snapshot mit vorinstalliertem Docker + Nightwatch-Compose, Validierung via `img_check.sh`, Einreichung über das DO **Vendor Portal** und **manuelles Review** durch das DO-Team. Lohnt sich erst, wenn das Produkt stabil ist.

**Update-Mechanik: Beides kombinieren.**
- **Eingebauter Update-Check** (Pflicht laut Ticket-Geist): App fragt periodisch die **GitHub Releases API** (`GET /repos/kai-osthoff/nightwatch/releases/latest`) ab, vergleicht `tag_name` (SemVer) mit der eigenen `APP_VERSION` und zeigt im UI einen Hinweis „Update verfügbar → v1.4.0" inkl. Changelog-Link. **Er aktualisiert nicht selbst**, sondern gibt die Anleitung (`docker compose pull && docker compose up -d`).
- **Watchtower optional** als Opt-in für Kunden, die vollautomatische Updates wollen — aber **standardmäßig aus** und wenn, dann im **Notify-Only-Modus** empfehlen. ⚠️ Wichtig: das klassische `containrrr/watchtower` wurde am **17.12.2025 archiviert**; aktiver Fork ist `nickfedor/watchtower`. Deshalb Watchtower nur als Kür, nicht als tragende Säule.

**DB-Migrationen: Migrate-on-Startup mit Guard.** Der App-Container führt beim Boot ausstehende Migrationen aus, aber **erst nachdem die DB via `depends_on` + Healthcheck** als „healthy" gemeldet ist. So bleibt `docker compose pull && up -d` ein sicherer Ein-Schritt-Update für die MSP-Zielgruppe (Single-Instance). Für spätere Multi-Instance-Deployments Migrationen in einen separaten One-Shot-Service (`condition: service_completed_successfully`) auslagern.

**Versionierung: SemVer-Tags, `latest` NICHT für Produktion empfehlen.** GitHub Actions baut bei jedem `v*`-Tag Multi-Arch-Images (`linux/amd64,linux/arm64`) nach `ghcr.io` mit Tags `1.4.0`, `1.4`, `1`, `latest`. Im veröffentlichten Compose-Template wird eine **gepinnte Minor-Version** (`:1.4`) referenziert, nicht `:latest` — reproduzierbar, aber Patch-Updates fließen mit.

---

## 1. DigitalOcean Marketplace

Zwei getrennte Listing-Typen, je eigenes Repo/Prozess:

### a) Droplet-basierte 1-Click App (für Nightwatch relevant)

Ein vorkonfiguriertes **Droplet-Image (Snapshot)**, das ein Kunde mit einem Klick als VM startet. Passt gut zu Nightwatch: Image = Ubuntu + Docker + Nightwatch-Compose vorinstalliert.

**Ablauf (laut DO Vendor Docs & `digitalocean/marketplace-partners`):**
1. **Interesse anmelden** über das Marketplace-Vendor-Formular; danach **Vendor-Portal-Zugang** anfordern (`one-clicks-team@digitalocean.com`).
2. **Build-Droplet** manuell aufsetzen und konfigurieren (empfohlen: 6-USD-Droplet, damit das Image auf allen Größen läuft).
3. **Pflicht-Software:** `cloud-init` (≥0.79) und `openssh-server`.
4. **First-Boot-Scripts** nach `/var/lib/cloud/scripts/per-instance/` (Nummern-Präfix = Reihenfolge). **First-Login-Script** in `/root/.bashrc`, das sich nach einmaliger Ausführung selbst entfernt (z. B. Ersteinrichtung, Passwort-Prompt).
5. **Validierung & Cleanup** mit den DO-Skripten: `cleanup.sh` (entfernt Secrets/Keys/History → Security) und `img_check.sh` (prüft Marketplace-Kompatibilität). Beide MÜSSEN fehlerfrei durchlaufen.
6. **Finales Image bauen** — empfohlen via **Packer** (`packer build marketplace-image.json`) für reproduzierbare Snapshots. Reproduzierbar + CI-fähig.
7. **Einreichen** des Snapshots über das Vendor Portal → **manuelles Review durch das DO-Marketplace-Team**.
8. **Updates** nach Freigabe: Image/OS/Software-Angaben per **PATCH an die Vendor-API** aktualisierbar → in CI/CD integrierbar (neuer Nightwatch-Release ⇒ neues Snapshot ⇒ API-Update).

**Kosten/Pflichten:** In der öffentlichen Doku werden **keine Vendor-Gebühren oder Revenue-Share** genannt; Pflicht ist ein valides, `img_check.sh`-konformes, sicherheitsbereinigtes Image. Kunde zahlt nur die Droplet-Ressourcen.

### b) Kubernetes 1-Click App (für MVP unnötig)

Wird als **Helm-3-Chart** eingereicht (Repo `digitalocean/marketplace-kubernetes`). Setzt DOKS-Cluster + Helm beim Kunden voraus. **Überdimensioniert** für ein Single-Container-Monitoring-Tool an MSPs — erst bei echtem K8s-Bedarf sinnvoll.

**Einordnung für Nightwatch:** Droplet-1-Click ist der richtige DO-Weg, aber **spätere Phase** — der Packer-/Review-Overhead lohnt erst nach Produktreife. Compose + Portainer decken die frühe Verteilung vollständig ab.

---

## 2. Portainer App Templates (v3)

Portainer kann eine **externe `templates.json`** laden (URL in Settings → App Templates). Damit erscheint Nightwatch als 1-Klick-Kachel in jeder Portainer-Instanz, die auf die URL zeigt.

**Format (v3):** Top-Level `{ "version": "3", "templates": [ ... ] }`. Pro Eintrag u. a.:
- `type`: **`3` = Compose-Stack** (auch `1` = Container, `2` = Swarm-Stack möglich)
- `title`, `description`, `logo`, `categories` (z. B. `["monitoring"]`), `platform` (`linux`)
- `repository`: `{ "url": "<git-repo>", "stackfile": "docker-compose.yml" }` — Portainer zieht das Compose-File direkt aus dem angegebenen Git-Repo/Pfad
- `env`: Array konfigurierbarer Umgebungsvariablen (IMAP-Host, Zugangsdaten, Alert-Ziel …), die Portainer dem Nutzer als Formularfelder anzeigt

**Hosting:** Die `templates.json` (und die referenzierten Compose-Files) einfach **im eigenen GitHub-Repo** ablegen und die **Raw-URL** (`raw.githubusercontent.com/...`) verbreiten → kostenlos, versioniert, PR-Workflow, stabile URL. **Kein Portainer-Freigabeprozess** — der Katalog ist offen, jeder trägt seine URL selbst ein. Optional lässt sich der Eintrag zusätzlich in das offizielle `portainer/templates`-Repo per PR einreichen.

**Hinweis:** Für maximale Kompatibilität Compose schlank halten; ältere Portainer-Doku vermerkt Format-Eigenheiten beim inline definierten Stack — die **`repository`+`stackfile`-Variante mit gepflegtem Compose im Git-Repo** umgeht das und ist der empfohlene Weg.

---

## 3. Docker-Compose-Template als Basis-Distribution

Das Fundament aller Kanäle. Ein einziges `docker-compose.yml` (Nightwatch-App + DB, z. B. Postgres) + `.env.example`. On-Prem-Nutzer: Repo klonen bzw. Compose kopieren → `.env` ausfüllen → `docker compose up -d`.

Eckpunkte:
- Image gepinnt auf `ghcr.io/kai-osthoff/nightwatch:1.4` (Minor-Pin, kein `latest`)
- `depends_on` mit **DB-Healthcheck** (`condition: service_healthy`), damit Migrationen erst nach DB-Bereitschaft laufen
- Named Volume für DB-Persistenz; benannte Volumes bleiben über Updates erhalten
- Restart-Policy `unless-stopped`
- Update-Weg im README: `docker compose pull && docker compose up -d`

Portainer- und DO-Distribution referenzieren **dasselbe** Compose — Single Source of Truth.

---

## 4. Update-Mechanismus im Vergleich

| Ansatz | Wie | Pro | Contra | Für Nightwatch |
|---|---|---|---|---|
| **Eingebauter Update-Check** | App pollt GitHub Releases API (`/releases/latest`), vergleicht `tag_name` vs. `APP_VERSION`, zeigt Banner + Changelog | Volle Kontrolle, im Produkt sichtbar, kein Fremdtool, keine Selbst-Restarts | Nutzer muss `pull && up -d` selbst ausführen | **Ja – Kern.** Passt zur „Anwender ziehen Updates einfach"-Anforderung |
| **Watchtower** | Sidecar-Container pollt Registry, ersetzt Container bei neuem Digest | Vollautomatisch, kein UI nötig | ⚠️ `containrrr/watchtower` **seit 17.12.2025 archiviert** (Fork: `nickfedor/watchtower`); Auto-Restarts bei Breaking Changes riskant | **Optional/Opt-in**, standardmäßig aus, Notify-Modus empfehlen |
| **Beides** | Update-Check als Default-UX; Watchtower als dokumentierte Opt-in-Option | Deckt manuelle + automatische Kundschaft ab | Doppelte Doku | **Empfohlen** |

**Warum kein Auto-Update als Default:** MSPs wollen Change-Kontrolle; ein UI-Hinweis + expliziter `pull` ist vorhersehbarer als selbsttätige Neustarts — gerade bei einem Monitoring-Tool, dessen Ausfall gefährlich wäre.

### DB-Migrationen beim Update

- **MVP-Pattern (Single-Instance): Migrate-on-Startup.** App-Entrypoint führt ausstehende Migrationen **idempotent** aus, sobald die DB `healthy` ist (`depends_on: condition: service_healthy`). Damit bleibt Update = ein Befehl.
- **Skalierungs-Pattern (später): entkoppeln.** Migrationen aus dem App-Start herauslösen in einen One-Shot-Migrations-Service (`condition: service_completed_successfully`) oder einen manuellen CLI-Schritt — verhindert Races/Korruption bei mehreren App-Repliken.
- Grundsätze: Migrationen **vorwärts-kompatibel** halten, Volume-Persistenz sichern, im Changelog Breaking-Migrationen markieren.

---

## 5. Versionierung & Release-Prozess

- **SemVer** mit `v`-präfigierten Git-Tags (`v1.4.0`). Tag = einziger Release-Trigger.
- **GitHub Actions** bei `push: tags: ['v*']`: `docker/setup-qemu-action` + `setup-buildx-action` → `docker/metadata-action` (Tag-Patterns `type=semver,pattern={{version}}` / `{{major}}.{{minor}}` / `{{major}}`) → `docker/login-action` gegen `ghcr.io` (via `GITHUB_TOKEN`, `packages: write`) → `docker/build-push-action` mit `platforms: linux/amd64,linux/arm64`, `push: true`.
- Erzeugte Tags: `ghcr.io/kai-osthoff/nightwatch:1.4.0`, `:1.4`, `:1`, `:latest`.
- **`latest` vs. gepinnt:** `latest` nur für Ausprobieren/CI; im **veröffentlichten Compose Minor-Pin `:1.4`** (Patches automatisch, keine Breaking-Sprünge). Doku empfiehlt Kunden, bewusst zu pinnen.
- **Changelog:** `CHANGELOG.md` (Keep-a-Changelog) + **GitHub Release Notes** pro Tag. Der In-App-Update-Check verlinkt genau diese Release-Seite.
- **`APP_VERSION`** zur Build-Zeit ins Image (Label/ENV), damit der Update-Check die laufende Version kennt.

---

## Quellen

- [DigitalOcean – Marketplace (Übersicht)](https://docs.digitalocean.com/products/marketplace/)
- [DigitalOcean – Droplet 1-Click Apps](https://docs.digitalocean.com/products/marketplace/droplet-1-click-apps/)
- [digitalocean/marketplace-partners (README: Packer, cleanup.sh, img_check.sh, Vendor-Portal)](https://github.com/digitalocean/marketplace-partners/blob/master/README.md)
- [digitalocean/droplet-1-clicks (Packer-Build-Scripts)](https://github.com/digitalocean/droplet-1-clicks)
- [DigitalOcean – Kubernetes 1-Click Apps (Helm 3)](https://docs.digitalocean.com/products/marketplace/kubernetes-1-click-apps/)
- [digitalocean/marketplace-kubernetes](https://github.com/digitalocean/marketplace-kubernetes)
- [Portainer – App Template JSON Format](https://docs.portainer.io/advanced/app-templates/format)
- [Portainer – Build & host your own app templates](https://docs.portainer.io/advanced/app-templates/build)
- [portainer/templates (offizielle v3-Templates)](https://github.com/portainer/templates)
- [Watchtower – Doku](https://containrrr.dev/watchtower/) · [Notify-Only](https://containrrr.dev/watchtower/notifications/)
- [containrrr/watchtower (GitHub – archiviert 17.12.2025)](https://github.com/containrrr/watchtower)
- [Docker Docs – Multi-platform images with GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [docker/metadata-action (SemVer-Tag-Patterns)](https://github.com/docker/metadata-action)
- [GitHub Docs – Working with the Container registry (ghcr.io)](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub REST API – Releases (`/releases/latest`)](https://docs.github.com/en/rest/releases/releases)
- [Decoupling database migrations from server startup](https://pythonspeed.com/articles/schema-migrations-server-startup/)
