# EventForge Secure Node.js & Express Backend

Production-grade, secure backend for the **EventForge Event Booking System**, featuring **Razorpay Orders API integration**, cryptographic HMAC-SHA256 signature verification, server-enforced pricing (Zero Trust), and atomic database seat reservations.

---

## 🔒 Security Architecture Highlights

1. **Zero Trust Pricing (Rule 5):**
   - The frontend never dictates the ticket price or total amount.
   - The server looks up the event and tier price from the database, validates promo codes on the server, and calculates the exact amount in subunits (paise for INR).

2. **Secret Key Isolation (Rule 6):**
   - `RAZORPAY_KEY_SECRET` resides strictly in `backend/.env`.
   - The frontend only ever receives the public `keyId` (e.g., `rzp_test_...` or `rzp_live_...`).

3. **Cryptographic Payment Verification (Rule 3 & 7):**
   - Tickets are issued **only** after verifying the payment signature on the server:
     `HMAC_SHA256(order_id + "|" + payment_id, RAZORPAY_KEY_SECRET) === razorpay_signature`
   - Seat inventory is decremented atomically inside the database transaction.

4. **Transparent Readiness State:**
   - The backend runs in sandbox simulation mode when keys are not yet provided, and transitions to live Razorpay gateway processing as soon as credentials are configured in `.env`.

---

## 📁 Backend Directory Structure

```
backend/
├── server.js              # Express app, security middleware, and REST routes
├── db.js                  # Database layer (SQLite / persistent data engine)
├── razorpayService.js     # Razorpay Orders API & HMAC signature verification
├── package.json           # Dependencies (express, cors, dotenv, razorpay)
├── .env.example           # Environment variable template
├── .gitignore             # Secrets & database ignore rules
├── README.md              # Setup, testing, and deployment guide
└── data/                  # Auto-generated database storage (git-ignored)
    └── eventforge.db      # SQLite database file
```

---

## 🛠️ Step-by-Step Local Setup

### 1. Navigate to the backend directory and install dependencies:
```bash
cd backend
npm install
```

### 2. Configure Environment Variables:
```bash
cp .env.example .env
```
Open `backend/.env` and configure your credentials:
```env
PORT=5000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000,http://localhost:5173

# Obtain your keys from https://dashboard.razorpay.com/#/accesskeys
RAZORPAY_KEY_ID=rzp_test_YourTestKeyId
RAZORPAY_KEY_SECRET=YourTestKeySecret

PAYMENT_CURRENCY=INR
DATABASE_FILE=./data/eventforge.db
```

> **Note on Testing:** If you don't have Razorpay keys yet, the server will start in **Test Simulation Mode**, allowing you to test endpoints safely without failing requests.

### 3. Run the Backend:
```bash
# Start server in production mode
npm start

# Or with live reload in development mode (Node 18+)
npm run dev
```

The server will output:
```
🚀 EventForge Backend Server is running on port 5000
🔗 API Base: http://localhost:5000/api
🛡️ Razorpay Status: ...
```

---

## 📡 API Endpoints Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health status, database stats & Razorpay gateway mode |
| `GET` | `/api/config/public` | Public Razorpay key ID & currency for client checkout |
| `GET` | `/api/events` | List all events with real-time seat inventory |
| `GET` | `/api/events/:id` | Single event details with ticket tiers |
| `POST` | `/api/bookings/create-order` | Server creates Razorpay Order & pending booking |
| `POST` | `/api/payments/verify` | Verifies HMAC signature, decrements seats, issues ticket |
| `GET` | `/api/bookings/:bookingRef` | Fetch booking details, ticket QR code, & payment audit |
| `GET` | `/api/bookings/user/:userId` | Fetch all bookings belonging to a user |
| `POST` | `/api/bookings/:id/cancel` | Cancel booking & restore seats to inventory |

---

## 🧪 Testing the API via cURL

### 1. Check Health & Gateway Status:
```bash
curl http://localhost:5000/api/health
```

### 2. Create a Payment Order:
```bash
curl -X POST http://localhost:5000/api/bookings/create-order \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-101",
    "tierId": "tier-101-standard",
    "quantity": 2,
    "promoCode": "EARLYBIRD20",
    "attendeeName": "Alex Rivera",
    "attendeeEmail": "alex.rivera@example.com",
    "attendeePhone": "+919876543210"
  }'
```

### 3. Verify Payment & Issue Ticket:
```bash
curl -X POST http://localhost:5000/api/payments/verify \
  -H "Content-Type: application/json" \
  -d '{
    "bookingRef": "<BOOKING_REF_FROM_STEP_2>",
    "razorpayOrderId": "<ORDER_ID_FROM_STEP_2>",
    "razorpayPaymentId": "pay_test_123456789",
    "razorpaySignature": "<HMAC_SHA256_SIGNATURE>"
  }'
```

### 4. Fetch Issued Ticket Pass:
```bash
curl http://localhost:5000/api/bookings/<BOOKING_REF>
```

---

## 🚀 Deployment Guide (Separate from Frontend)

The backend is completely decoupled and can be deployed anywhere Node.js runs.

### Option A: Render.com (Recommended for Free/Easy Node Hosting)
1. Push your repository to GitHub (ensure `backend/.env` is NOT committed).
2. Go to [Render Dashboard](https://dashboard.render.com/) -> **New Web Service**.
3. Select your repository.
4. Set:
   - **Root Directory:** `backend`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. In **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `PORT` = `10000`
   - `RAZORPAY_KEY_ID` = `rzp_live_...` (or test key)
   - `RAZORPAY_KEY_SECRET` = `...`
   - `CORS_ORIGIN` = `https://your-frontend-app.run.app`
6. Click **Deploy**. Your API will be live at `https://your-app.onrender.com`.

### Option B: Railway.app
1. Create a project in [Railway.app](https://railway.app/).
2. Connect your GitHub repository.
3. Under service settings, set **Root Directory** to `/backend`.
4. Add environment variables in the Railway dashboard.
5. Railway automatically provides an HTTPS endpoint and port management.

### Option C: AWS Elastic Beanstalk / EC2 / DigitalOcean
1. Provision an Ubuntu / Node.js instance.
2. Clone repo and run `cd backend && npm install --production`.
3. Set environment variables using PM2 or systemd:
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name eventforge-backend
   pm2 startup
   pm2 save
   ```
4. Put Nginx in front with SSL (Let's Encrypt / Certbot) proxying to `http://127.0.0.1:5000`.
