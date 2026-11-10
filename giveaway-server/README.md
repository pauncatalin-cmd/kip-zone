# KIP Giveaway

## Pornire și publicare

1. Folosește Node.js 24 sau mai nou. Copiază `.env.example` în `.env`. Generează separat cheile pentru administrare și, dacă activezi relay-ul TikTok, pentru acesta. Comanda de mai jos produce câte o cheie. Păstrează secretele în `.env` sau în setările private ale serviciului.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   node --env-file-if-exists=.env giveaway-server/server.mjs
   ```

2. Local, deschide `http://127.0.0.1:3000/#giveaway`. În producție, rulează un singur proces pentru Giveaway, cu disc persistent pentru `GIVEAWAY_DB` și cu HTTPS în față. Serverul poate servi întregul site. Dacă păstrezi site-ul pe găzduirea statică, poți direcționa `/giveaway-api/*` către serviciu prin proxy. Pentru un API pe alt domeniu, setează în `giveaway/config.js` originea HTTPS a API-ului, fără cale sau slash final, și pe server setează `GIVEAWAY_SITE_ORIGIN` la originea exactă a site-ului, de exemplu `https://kipzone.ro`. Publică fișierele statice după configurarea originii. Un site pe HTTPS trebuie să folosească și un API pe HTTPS.
3. În secțiunea Giveaway, deschide **Administrare Giveaway** și introdu `GIVEAWAY_ADMIN_TOKEN`. Cheia rămâne în memoria paginii până la blocare sau reîncărcare. În OBS adaugă o sursă **Browser** și folosește linkul **OVERLAY OBS** din panou, de exemplu `https://kipzone.ro/giveaway/overlay.html`. O dimensiune de 680 × 450 px lasă loc pentru card și umbră. Sursa este transparentă între runde și preia starea după reîncărcare.

SQLite păstrează runda, lista și rezultatul la repornire. Lista publică afișează numele din chat și platforma. Identificatorii rămân în baza de date și sunt șterși la resetare. Protejează fișierul bazei și copiile sale de rezervă.

## Conectarea chat-urilor

### Kick

1. Creează o aplicație în setările de dezvoltator Kick și activează webhook-ul către `https://<gazda-api>/giveaway-api/kick`.
2. Pune ID-ul numeric al canalului `kipzone` în `KICK_BROADCASTER_ID`. Îl poți obține din `GET https://api.kick.com/public/v1/channels?slug=kipzone` cu token de aplicație și câmpul `broadcaster_user_id`.
3. Cu tokenul de aplicație obținut prin `client_credentials` de la `https://id.kick.com/oauth/token`, verifică abonamentele la `GET https://api.kick.com/public/v1/events/subscriptions`. Dacă lipsește abonamentul, trimite la același URL un `POST` cu `Authorization: Bearer <token>` și `Content-Type: application/json`. Folosește ID-ul canalului la `broadcaster_user_id`.

   ```json
   {"broadcaster_user_id": 123456, "events": [{"name": "chat.message.sent", "version": 1}], "method": "webhook"}
   ```

4. Serverul verifică semnătura RSA a corpului original, prospețimea evenimentului și canalul. La eșecuri repetate de livrare verifică abonamentul și refă-l dacă Kick l-a dezactivat. La răspunsuri `429` pentru configurare, respectă `Retry-After`.

[Configurarea aplicației și a webhook-ului](https://github.com/KickEngineering/KickDevDocs/blob/main/events/introduction.md) · [Abonamente Kick](https://github.com/KickEngineering/KickDevDocs/blob/main/events/subscribe-to-events.md)

### YouTube Live

1. Activează YouTube Data API v3 într-un proiect Google Cloud. Configurează consimțământul OAuth și un client OAuth. Autorizează contul care gestionează canalul, cu acces offline (`access_type=offline`) și scope `https://www.googleapis.com/auth/youtube.readonly`. Schimbă codul de autorizare prin fluxul OAuth al clientului pentru un refresh token. Pentru o configurare manuală, poți folosi [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) cu un client Web propriu și cu adresa Playground adăugată ca redirect URI. În Playground alege **Use your own OAuth credentials**, autorizează scope-ul de mai sus, apoi folosește **Exchange authorization code for tokens**. Verifică starea de publicare a aplicației OAuth și eventualele limitări ale tokenurilor de test.
2. Completează `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_CHANNEL_ID` (ID-ul `UC…`, nu handle-ul) și `YOUTUBE_VIDEO_ID` (ID-ul transmisiei cu chat activ). Pentru o nouă transmisie schimbă ID-ul video și repornește serviciul. Readerul validează canalul înainte de a citi chatul.
3. Serviciul interoghează chatul doar când runda este deschisă. Respectă `pollingIntervalMillis`, configurarea `YOUTUBE_POLL_MS` (implicit 10 s), `Retry-After` și reîncearcă gradual la erori. O cerere `liveChatMessages.list` costă 5 unități de cotă. La 10 s, o oră consumă aproximativ 1.800 de unități dacă API-ul permite acest ritm. În cazul cotelor epuizate, panoul afișează problema și readerul face pauză. Crește intervalul dacă runde lungi împart cota cu alte aplicații.

[OAuth Google](https://developers.google.com/identity/protocols/oauth2/web-server) · [Citirea chatului](https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/list?hl=en) · [Cotele YouTube](https://developers.google.com/youtube/data/determine_quota_cost)

### TikTok LIVE

Este necesar un furnizor autorizat pentru chatul TikTok LIVE. Nu am identificat în documentația publică TikTok for Developers o interfață directă pentru acest chat. Configurează adaptorul furnizorului să trimită mesajele la `POST https://<gazda-api>/giveaway-api/tiktok`, cu `Authorization: Bearer <TIKTOK_RELAY_TOKEN>` și `Content-Type: application/json`. Acesta este contractul KIP pentru adaptor, nu un format de eveniment TikTok.

```json
{
  "channelId": "id-ul-canalului-autorizat",
  "accountId": "id-stabil-al-autorului",
  "displayName": "Nume în chat",
  "text": "!kip",
  "sentAt": "2026-11-10T19:15:31.000Z"
}
```

Setează același `channelId` în `TIKTOK_CHANNEL_ID`. Adaptorul folosește ID-ul stabil și ora originală din eveniment, autentifică sursa înainte să transmită, și reîncearcă doar la erori tranzitorii. Răspunsul `200` cu `added: 0` înseamnă că mesajul nu a adăugat o înscriere.

[Autorizare și permisiuni TikTok](https://developers.tiktok.com/docs/en/scopes-overview)

## Operarea unei runde

- **Start** deschide înscrierile cu un singur cuvânt-cheie, de exemplu `!kip`. Mesajul trebuie să coincidă integral, ignorând majusculele și spațiile de la margini. Mesajele anterioare deschiderii sunt ignorate. Același ID pe aceeași platformă intră o singură dată, chiar dacă se schimbă numele afișat. Conturile de pe platforme diferite au identități separate.
- **Extrage** închide înscrierile și alege uniform dintre conturile deja recepționate. Înainte de extragere, lasă timp pentru livrarea webhook-urilor și cel puțin o interogare YouTube după ultimele mesaje, apoi verifică lista și starea surselor. În timpul animației, lista rămâne blocată. OBS și site-ul folosesc aceiași timpi și citesc același rezultat de pe server.
- **Reextrage** alege dintre conturile care n-au mai câștigat în runda curentă. **Reset** șterge lista și rezultatul și pregătește o rundă nouă.
- Înaintea primului giveaway real, deschide o rundă de probă cu toate transmisiile active. Trimite cuvântul-cheie de două ori de pe câte un cont pe fiecare platformă, verifică trei înscrieri și aceeași extragere în OBS și în site. Starea „recepție verificată” indică o recepție anterioară și afișează ultima oră, utilă pentru detectarea deconectărilor. Confirmă livrarea în chat înainte de eveniment.

Testele de integrare locale folosesc mesaje simulate și o semnătură Kick generată local. Rulează `node --test giveaway-server/server.test.mjs`.
