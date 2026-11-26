# Giveaway GTA 6

Paginile publice sunt `/giveaway/` și `/giveaway/extragere/`. Nu sunt în meniul de pe prima pagină și nu sunt în sitemap. Colectorul de chat stă în `tools/giveaway-collector/` și rulează pe PC-ul organizatorului.

Premiul este un voucher digital de 100 €, la alegerea câștigătorului: PlayStation Store, Xbox, Steam sau Amazon. Nu se preschimbă în bani. Câștigătorul trebuie să fie pe live și să scrie în chat, de pe contul câștigător, în 3 minute de la anunț. Altfel trece la rezervă, cu același termen. Voucherul se trimite în privat după confirmarea din chat. Extragerea este pe 24 decembrie 2026, ora 20:00, Europa/București. În Germania, iarna, asta este ora 19:00. Înscrierile țin de la 26 noiembrie 2026, ora 00:00, până la ora extragerii. Comanda este exact `!gta6`.

## Variabile de mediu în Vercel

Creează-le în Project → Settings → Environment Variables, pentru Production și Preview. Nu le pune în git. Stocarea este Upstash Redis prin REST. Integrarea din Vercel Marketplace setează `KV_REST_API_URL` și `KV_REST_API_TOKEN`; aceleași valori merg și sub numele `UPSTASH_REDIS_REST_URL` și `UPSTASH_REDIS_REST_TOKEN`. Dacă ambele perechi există, se folosesc numele `UPSTASH_`.

| Variabilă | Unde | Rol |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` sau `KV_REST_API_URL` | Vercel | URL-ul REST al bazei Upstash, cu `https://` |
| `UPSTASH_REDIS_REST_TOKEN` sau `KV_REST_API_TOKEN` | Vercel | Tokenul REST Upstash |
| `GIVEAWAY_INGEST_SECRET` | Vercel și `.env` de pe PC | Bearer pentru `POST /api/giveaway/entry` |
| `GIVEAWAY_ADMIN_SECRET` | Vercel | Bearer pentru ban, unban, extragere și CSV |

Fără un URL și un token din perechile de mai sus, pagina se încarcă și afișează „nu este configurată”. Nu pică.

Dacă `GIVEAWAY_ADMIN_SECRET` lipsește, rutele de admin acceptă `GIVEAWAY_INGEST_SECRET`. Mai bine ții secretele separate.

Cheile `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` și `YOUTUBE_API_KEY` de pe site sunt pentru live și urmăritori. Giveaway-ul de pe Vercel nu le citește. Cheia de YouTube pentru chat stă doar în `.env` de pe PC.

Generează un secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Extragerea, pe scurt

1. Generează un seed lung și salvează-l undeva sigur. Serverul nu îl păstrează la commit.
2. `POST /api/giveaway/draw` cu `Authorization: Bearer` secretul de admin și body `{"action":"commit","seed":"..."}`. Hash-ul apare pe pagină.
3. La 20:00 așteaptă un minut, ca să intre ultimele mesaje, apoi `{"action":"freeze"}`.
4. Pe live, `{"action":"reveal","seed":"..."}`. Deschide `/giveaway/extragere/`. Roata doar arată rezultatul.
5. CSV-ul cu ID-urile interne este `GET /api/giveaway/export`. Nu îl publica.

Ban și unban: `POST /api/giveaway/ban` și `POST /api/giveaway/unban`, cu `{"platform":"tiktok","userId":"..."}`. Fă-le înainte de freeze.

Clasamentul public este `GET /api/giveaway/leaderboard`. Nu conține ID-uri interne și sare peste conturile eliminate.

## Teste

```powershell
node --test
```
