# Studio Render AI

Interior design + rendering AI (OpenAI Vision + DALL-E 3).

## Cosa è stato sistemato in questa versione

- Select cliente rotto (`onchange` senza valore → `currentClient` undefined)
- `node-fetch` v3 + `.buffer()` incompatibile (ora `fetch` nativo + `arrayBuffer`)
- Path statici relativi al CWD (ora sempre `__dirname`)
- Email cliente obbligatoria anche se vuota
- Endpoint pubblico `/api/admin/setup` che creava credenziali hard-coded
- Auth mescolata nel file errorHandler
- Dipendenze inutilizzate (`sharp`, `form-data`, `node-fetch`)
- File analizzato cancellato ma URL restituito (404)
- CORS e static files più affidabili su Railway

## Avvio locale

```bash
npm install
cp .env.example .env
# modifica .env
npm start
```

- App: http://localhost:8080
- Admin: http://localhost:8080/admin
- Health: http://localhost:8080/api/health

Serve MongoDB in ascolto e una chiave OpenAI valida.

## Variabili ambiente

| Variabile | Descrizione |
| --- | --- |
| `MONGODB_URI` | Connection string MongoDB |
| `OPENAI_API_KEY` | Chiave OpenAI |
| `JWT_SECRET` | Secret JWT (≥ 16 caratteri) |
| `PORT` | Porta (default 8080) |
| `NODE_ENV` | `development` o `production` |
| `CORS_ORIGIN` | Origine CORS (`*` o URL) |
| `ADMIN_USERNAME` | Admin creato al primo avvio |
| `ADMIN_PASSWORD` | Password admin iniziale |
| `ADMIN_EMAIL` | Email admin iniziale |

Al primo avvio, se l’admin non esiste, viene creato da `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Deploy Railway

1. Carica questa cartella su GitHub
2. New Project → Deploy from GitHub
3. Imposta le variabili d’ambiente
4. Attendi il deploy

Nota: su Railway la cartella `uploads/` è effimera. Per file permanenti usa S3 o Cloudinary.
