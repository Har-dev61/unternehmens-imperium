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
# In der Datei server_name auf deine Domain/IP setzen:
sudo nano /etc/nginx/sites-available/imperium
sudo ln -s /etc/nginx/sites-available/imperium /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default     # optional
sudo nginx -t && sudo systemctl reload nginx
```

Jetzt ist das Spiel unter `http://DEINE-DOMAIN/` erreichbar.

## 9. HTTPS (empfohlen)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d game.example.com
```

Certbot trägt das Zertifikat automatisch in die nginx-Site ein und richtet die
Erneuerung ein. Danach läuft alles über `https://` — der Client nutzt dank
`location.origin` automatisch dieselbe (sichere) URL.

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

## Wichtige Sicherheits-Hinweise (für echten Betrieb)

Das Backend ist bewusst kompakt. Vor produktivem Einsatz ergänzen:

- **Rate-Limiting** (z. B. `express-rate-limit`) gegen Brute-Force/Spam.
- **Token-Ablauf** statt dauerhafter Bearer-Tokens.
- **Anti-Cheat**: serverseitige Plausibilitätsprüfung der eingereichten Firmenwerte
  (aktuell vertraut die Bestenliste den Client-Angaben).
- Regelmäßige `apt upgrade` / Node-Sicherheitsupdates.
