# Colector giveaway GTA 6

Programul stă pe PC-ul tău cât timp ești live. Prinde comanda exactă `!gta6` din chatul TikTok (`@kipzone.ro`) și din chatul YouTube (`@kipanu`) și o trimite la kipzone.ro.

O singură intrare per cont per live. Dacă trimiți de două ori aceeași persoană, serverul o numără o dată. Conturile de TikTok și YouTube sunt separate. Programul nu citește data creării contului, deci regula de 7 zile se aplică doar dacă acea dată este trimisă.

## Ce îți trebuie

- Windows 10 sau 11
- Node.js 22 LTS, de pe [https://nodejs.org](https://nodejs.org). La instalare lasă bifat „Add to PATH”.
- Secretul `GIVEAWAY_INGEST_SECRET`, același pe care îl pui în Vercel
- Pentru YouTube: o cheie YouTube Data API v3

## Pași pe Windows

1. Copiază folderul `tools/giveaway-collector` pe PC, de exemplu pe Desktop.
2. Deschide PowerShell în acel folder. Poți scrie `powershell` în bara de adrese a folderului.
3. Rulează:

```powershell
npm install
copy .env.example .env
notepad .env
```

4. În `.env` completează, fără ghilimele:

```text
GIVEAWAY_API_URL=https://kipzone.ro/api/giveaway/entry
GIVEAWAY_INGEST_SECRET=secretul-din-vercel
YOUTUBE_API_KEY=cheia-youtube
```

`TIKTOK_UNIQUE_ID` rămâne `kipzone.ro`. `YOUTUBE_CHANNEL_ID` rămâne canalul @kipanu. Lasă `YOUTUBE_VIDEO_ID` gol ca să ia live-ul curent. Dacă vrei doar TikTok, lasă `YOUTUBE_API_KEY` gol. Dacă vrei doar YouTube, pune `TIKTOK_UNIQUE_ID=off`.

5. Pornește înainte de live și lasă fereastra deschisă:

```powershell
node collector.js
```

6. Oprești cu Ctrl+C. Nu închide fereastra în timpul live-ului, altfel mesajele din pauză nu se numără.

Jurnalul rămâne în `data/events.jsonl`. Nu îl șterge în timpul campaniei. `data/seen.log` ține minte ce a fost deja trimis, ca o repornire să nu dubleze intrările.

## Cheia de YouTube

1. Intră în Google Cloud Console.
2. Activează YouTube Data API v3.
3. Creează o cheie API și pune-o doar în `.env`. Nu o pune pe git și nu o trimite nimănui.

YouTube nu dă @handle-ul în chatul live. Colectorul salvează numele afișat în chat. Căutarea de pe site merge cu acel nume.

## Dacă nu se conectează

- „TikTok nu este live” înseamnă că încă nu ai pornit live-ul. Programul reîncearcă singur.
- „Secretul a fost respins” înseamnă că `GIVEAWAY_INGEST_SECRET` nu este identic cu cel din Vercel.
- Pentru un preview Vercel, poți pune temporar adresa preview la `GIVEAWAY_API_URL`. La live-ul real folosește `https://kipzone.ro/api/giveaway/entry`.
