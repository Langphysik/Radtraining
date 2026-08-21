# Radtraining — Setup auf GitHub Pages

Diese App läuft komplett im Browser. Daten (Trainingslog, Blöcke) werden **lokal
im Browser deines Handys** gespeichert (localStorage) — nicht auf GitHub, nicht
bei Anthropic. Wenn du die Seite auf einem anderen Gerät öffnest, siehst du dort
einen leeren Stand; es gibt keine automatische Synchronisierung zwischen Geräten.

## Einrichtung (einmalig, ca. 5 Minuten)

1. **Repository anlegen**
   Auf [github.com](https://github.com) einloggen (Account kostenlos, falls nötig) →
   oben rechts **+** → **New repository** → Name z. B. `radtraining` → **Public**
   auswählen (bei kostenlosen Accounts nötig für Pages; der Code enthält keine
   persönlichen Daten, die liegen ausschließlich lokal auf deinem Handy) → **Create repository**.

2. **Dateien hochladen**
   Im neuen Repo: **Add file** → **Upload files** → alle Dateien aus diesem Paket
   hineinziehen (`index.html`, `manifest.json`, `icon-192.png`, `icon-512.png`,
   `icon-180.png`) → **Commit changes**.
   Alle Dateien müssen im Root-Verzeichnis liegen (keine Unterordner).

3. **GitHub Pages aktivieren**
   Im Repo: **Settings** → **Pages** (linkes Menü) → unter **Build and deployment**:
   Source = **Deploy from a branch**, Branch = **main**, Ordner = **/ (root)** → **Save**.

4. **Warten & öffnen**
   Nach ca. 1 Minute ist die Seite erreichbar unter:
   `https://DEIN-BENUTZERNAME.github.io/radtraining/`
   (Fortschritt sieht man im Reiter **Actions** im Repo.)

## Auf dem Handy installieren

**iPhone (Safari):** Link öffnen → Teilen-Symbol (Quadrat mit Pfeil nach oben) →
**Zum Home-Bildschirm** → Hinzufügen.

**Android (Chrome):** Link öffnen → Menü (drei Punkte) → **App installieren** /
**Zum Startbildschirm hinzufügen**.

Die App öffnet sich danach wie eine normale App, ohne Browser-Adressleiste, mit
eigenem Icon.

## Updates später

Wenn die App weiterentwickelt wird (z. B. neuer Block-Typ, neues Feld): die
geänderte(n) Datei(en) im GitHub-Repo einfach erneut über **Add file → Upload
files** hochladen und den bestehenden Inhalt überschreiben (Commit bestätigen).
Dein Trainingslog bleibt davon unberührt, da es getrennt im Browser-Speicher liegt.
