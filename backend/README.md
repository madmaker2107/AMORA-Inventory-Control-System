# AMORA backend

Local Express + SQLite API for the AMORA supermarket console.

## Run

```powershell
cd backend
npm install
npm start
```

Open `http://localhost:4016` for the website. The database is created at `backend/data/amora.sqlite` and seeded on first run. Port `4016` is the authoritative AMORA development port; run only one backend instance.

Firebase setup is documented in the workspace root at `FIREBASE_SETUP.md`. Copy the root `.env.example` to `.env` before starting the server to enable Firebase client configuration. Local SQLite/JWT login remains available as a fallback until Firebase Admin verification is configured.

Demo login:

- Email: `admin@amora.local`
- Password: `amora123`

## Core API

- `POST /api/auth/login`
- `GET /api/dashboard`
- `GET|POST /api/products`
- `GET /api/inventory`
- `GET|POST /api/suppliers`
- `GET|POST /api/purchases`
- `POST /api/purchases/:id/receive`
- `GET|POST /api/customers`
- `POST /api/sales`
- `GET /api/sales`
- `POST /api/sales/:id/return`
- `GET /api/notifications`
- `GET /api/reports/sales`

Sales and goods receiving use SQLite transactions. Sales consume batches using FEFO and never allow expired or negative stock.
