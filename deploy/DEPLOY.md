# Deployment auf Debian 12 (Bookworm)

Architektur im Betrieb: **nginx** liefert die statischen Dateien (`index.html`,
`css/`, `js/`) aus und leitet `/api/` an das **Node-Backend** (Port 3000, nur
lokal) weiter. Dadurch laufen Seite und API über denselben Host → **kein CORS**.

```
Browser ──▶ nginx :80/:443 ──┬─▶ statische Dateien (/var/www/imperium)
                             └─▶ /api/  →  Node-Backend 127.0.0.1:3000  →  imperium.db (SQLite)
```

> Der Client wählt seine Backend-URL automatisch: lokal `http://localhost:3000`,
> sonst `location.origin` (= dieselbe Domain). Du musst im Code nichts ändern.

> **WebSockets (Echtzeit-Push):** Der Endpunkt `/api/ws` läuft über dieselbe
> `/api/`-Weiterleitung; die mitgelieferte nginx-Konfig reicht den `Upgrade`-Header
> durch (`map $http_upgrade $connection_upgrade`). Das Backend braucht dafür das
> `ws`-Paket — `npm ci --omit=dev` im `server/`-Ordner installiert es mit.

---

## 1. Node.js 24 installieren

Debian Bookworm liefert nur Node 18 — zu alt für `node:sqlite` (braucht ≥ 22.5).
Daher Node 24 über NodeSource:

```bash
sudo apt update && sudo apt install -y curl ca-certificates gnupg git
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # sollte v24.x zeigen
```

## 2. nginx installieren

```bash
sudo apt install -y nginx
```

## 3. Code auf den Server bringen

```bash
sudo mkdir -p /var/www/imperium
sudo git clone <DEIN-REPO> /var/www/imperium     # oder per scp/rsync hochladen
cd /var/www/imperium
```

## 4. Client bauen (TypeScript → js/)

Ist `js/` bereits eingecheckt, kannst du diesen Schritt überspringen. Andernfalls:

```bash
npm install            # installiert TypeScript (devDependency)
npm run build          # src/*.ts → js/
```

## 5. Backend-Abhängigkeiten installieren

```bash
cd /var/www/imperium/server
npm ci --omit=dev      # nur Express (kein TypeScript nötig)
```

## 6. Dienst-Benutzer & Rechte

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin imperium
sudo chown -R imperium:imperium /var/www/imperium
```

## 7. Backend als systemd-Dienst

```bash
sudo cp /var/www/imperium/deploy/imperium.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now imperium
sudo systemctl status imperium          # läuft es?
curl http://127.0.0.1:3000/api/health   # {"ok":true,...}
```

Logs: `journalctl -u imperium -f`
(Die Meldung „SQLite is an experimental feature" ist nur ein Hinweis, kein Fehler.)

## 8. nginx konfigurieren

```bash
sudo cp /var/www/imperium/deploy/nginx-imperium.conf /etc/nginx/sites-available/imperium
sudo ln -s /etc/nginx/sites-available/imperium /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default     # entfernt die nginx-Standardseite
sudo nginx -t && sudo systemctl reload nginx
```

Die mitgelieferte Konfig nutzt `server_name _` und lauscht damit **auf jede IP** —
ohne Domain musst du nichts anpassen. Das Spiel ist jetzt unter
`http://DEINE-SERVER-IP/` erreichbar (z. B. `http://203.0.113.10/`).

## 9. HTTPS — auch ohne eigene Domain (via sslip.io)

Für die nackte IP stellt Let's Encrypt keine Zertifikate aus. Trick: **sslip.io**
liefert kostenlos einen Hostnamen, der auf deine IP auflöst — `<IP>.sslip.io`.
Damit kann certbot ein gültiges Zertifikat ausstellen. Für `152.89.239.223` ist
der Hostname **`152.89.239.223.sslip.io`**.

```bash
# 1) server_name auf den sslip.io-Hostnamen setzen:
sudo sed -i 's/server_name _;/server_name 152.89.239.223.sslip.io;/' /etc/nginx/sites-available/imperium
sudo nginx -t && sudo systemctl reload nginx

# 2) Zertifikat holen (certbot richtet HTTPS + Auto-Erneuerung automatisch ein):
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 152.89.239.223.sslip.io --redirect -m deine@mail.de --agree-tos --no-eff-email
```

Danach das Spiel über **`https://152.89.239.223.sslip.io/`** aufrufen — gültiges
Schloss, keine Warnung. Der Client nutzt dank `location.origin` automatisch
dieselbe `https://`-Adresse, und der **Service Worker / die PWA** (Installieren,
Offline-Spiel) wird dadurch erst aktiv (braucht sicheren Kontext). Keine
Code-Änderung nötig.

> Hast du später eine **echte Domain**, einfach den DNS-A-Record auf die IP zeigen
> lassen und `sudo certbot --nginx -d deine-domain.de` ausführen.

## 10. Firewall

```bash
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'     # 80 + 443
sudo ufw enable
```

**Port 3000 NICHT freigeben** — das Backend ist nur lokal (127.0.0.1) gebunden
und ausschließlich über nginx erreichbar.

---

## Updates einspielen

```bash
cd /var/www/imperium
sudo -u imperium git pull
sudo -u imperium npm install && sudo -u imperium npm run build   # Client neu bauen
cd server && sudo -u imperium npm ci --omit=dev                  # falls Deps geändert
sudo systemctl restart imperium
```

## Datenbank & Backup

Die SQLite-Datei liegt unter `/var/www/imperium/server/imperium.db`
(plus `-wal`/`-shm` im WAL-Modus). Backup z. B. per Cron:

```bash
sqlite3 /var/www/imperium/server/imperium.db ".backup '/var/backups/imperium-$(date +\%F).db'"
```

## Sicherheit

Bereits im Backend umgesetzt:

- ✅ **Rate-Limiting** (`express-rate-limit`): 120 Anfragen/Min./IP allgemein,
  20 Anmeldeversuche/15 Min./IP auf `/api/auth/*` (gegen Brute-Force/Spam).
- ✅ **Token-Ablauf**: Bearer-Tokens laufen nach 7 Tagen ab; danach fordert der
  Client automatisch eine erneute Anmeldung an.
- ✅ **Anti-Cheat**: serverseitige Plausibilitätsprüfung der eingereichten
  Firmenwerte (endlich, Hard-Cap, exponentielle Schranke übers Kontoalter).
- ✅ **Passwort-Hashing** (scrypt + Salt), `trust proxy` korrekt für IP-Limits.

### Automatische Sicherheitsupdates (empfohlen)

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # „Ja" wählen
```

Das installiert Debian-Sicherheitsupdates automatisch. Node aktualisierst du bei
Bedarf über das NodeSource-Repo:

```bash
sudo apt update && sudo apt upgrade -y     # inkl. nodejs, wenn neue 24.x-Version da ist
sudo systemctl restart imperium
```

> Für sehr exponierte Instanzen zusätzlich erwägen: Token-Rotation/-Widerruf,
> echte serverseitige Spielsimulation als Anti-Cheat, sowie `fail2ban` für SSH.
