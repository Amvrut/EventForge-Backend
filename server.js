/**
 * ==============================================================================
 * EventForge Secure Backend Server
 * ==============================================================================
 * Express.js Server implementing:
 * - Razorpay Orders API
 * - Server-side HMAC-SHA256 signature verification
 * - Server-enforced pricing (Zero trust in frontend-supplied amounts)
 * - Atomic seat inventory decrement and ticket issuance
 * - CORS and environment security controls
 * ==============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const razorpayService = require('./razorpayService');

const app = express();
const PORT = process.env.PORT || 5000;

// Security & CORS Configuration
const rawCors = process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5173';
const allowedOrigins = rawCors
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, webhooks, server-to-server)
      if (!origin) return callback(null, true);

      const cleanOrigin = origin.replace(/\/+$/, '');
      const isAllowed = allowedOrigins.some(
        (allowed) => allowed === '*' || allowed === cleanOrigin
      );

      if (isAllowed) {
        return callback(null, true);
      }

      if (isProduction) {
        console.warn(
          `[CORS Blocked] Origin "${origin}" rejected by CORS whitelist in production: ${allowedOrigins.join(', ')}`
        );
        return callback(new Error(`Origin ${origin} is not authorized by CORS policy`));
      }

      // Dev-friendly fallback for local development
      return callback(null, true);
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ==============================================================================
// 1. System Health & Gateway Configuration Endpoints
// ==============================================================================

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  const events = db.getEvents();
  const razorpayStatus = razorpayService.getStatus();

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    database: {
      engine: 'sqlite/file-backed',
      path: typeof db.getDatabasePath === 'function' ? db.getDatabasePath() : 'eventforge.db',
      totalEvents: events.length,
    },
    cors: {
      isProduction,
      allowedOrigins,
    },
    razorpay: razorpayStatus,
  });
});

/**
 * Public configuration endpoint for frontend client
 * NEVER exposes RAZORPAY_KEY_SECRET!
 */
app.get('/api/config/public', (req, res) => {
  const config = razorpayService.getPublicConfig();
  res.json(config);
});

// ==============================================================================
// 2. Events & Inventory Endpoints
// ==============================================================================

/**
 * Get all events with live seat counts and ticket tiers
 */
app.get('/api/events', (req, res) => {
  try {
    const events = db.getEvents();
    res.json({ success: true, count: events.length, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get single event details
 */
app.get('/api/events/:id', (req, res) => {
  try {
    const event = db.getEventById(req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    res.json({ success: true, event });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// 3. Razorpay Order Creation (Server-Enforced Pricing)
// ==============================================================================

/**
 * POST /api/bookings/create-order
 *
 * CRITICAL SECURITY RULE:
 * NEVER trust the payment amount supplied by the frontend.
 * The server looks up the official tier price from the database,
 * validates promo codes on the server, and calculates the exact amount in paise.
 */
app.post('/api/bookings/create-order', async (req, res) => {
  try {
    const {
      eventId,
      tierId,
      quantity = 1,
      promoCode,
      attendeeName,
      attendeeEmail,
      attendeePhone,
      userId,
    } = req.body;

    // Validate inputs
    if (!eventId || !tierId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required booking parameters: eventId and tierId',
      });
    }

    const ticketQty = parseInt(quantity, 10);
    if (isNaN(ticketQty) || ticketQty < 1 || ticketQty > 10) {
      return res.status(400).json({
        success: false,
        error: 'Quantity must be a valid number between 1 and 10 tickets',
      });
    }

    if (!attendeeName || !attendeeEmail) {
      return res.status(400).json({
        success: false,
        error: 'Attendee name and email are required to create a booking',
      });
    }

    // 1. Fetch event and tier from database (SOURCE OF TRUTH)
    const event = db.getEventById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const tier = db.getTierById(eventId, tierId);
    if (!tier) {
      return res.status(404).json({ success: false, error: 'Selected ticket tier does not exist' });
    }

    // 2. Verify seat availability
    if (tier.available < ticketQty) {
      return res.status(400).json({
        success: false,
        error: `Only ${tier.available} seats remaining for tier "${tier.name}". Cannot book ${ticketQty} seats.`,
      });
    }

    // 3. SERVER-SIDE PRICING CALCULATION (Zero trust in frontend amount)
    const unitPrice = tier.price;
    const subtotal = unitPrice * ticketQty;

    // Server-side Promo code validation
    let discountPercent = 0;
    if (promoCode) {
      const code = String(promoCode).trim().toUpperCase();
      if (code === 'EARLYBIRD20') discountPercent = 20;
      else if (code === 'STUDENT50') discountPercent = 50;
      else if (code === 'VIP10') discountPercent = 10;
    }

    const discountAmount = Math.round((subtotal * discountPercent) / 100);
    const totalAmount = Math.max(0, subtotal - discountAmount);

    // Razorpay requires currency amount in smallest subunits (Paise for INR: 1 INR = 100 paise)
    // If ticket is free or 0, we can directly issue without payment gateway
    const amountInPaise = Math.round(totalAmount * 100);
    const currency = process.env.PAYMENT_CURRENCY || 'INR';

    // Generate unique human-readable booking reference
    const year = new Date().getFullYear();
    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const bookingRef = `EVT-${year}-${randSuffix}`;

    // 4. Create Razorpay Order via SDK
    let razorpayOrder = null;
    if (amountInPaise > 0) {
      razorpayOrder = await razorpayService.createOrder({
        amountInPaise,
        currency,
        receipt: bookingRef,
        notes: {
          eventId,
          eventTitle: event.title,
          tierId,
          tierName: tier.name,
          quantity: String(ticketQty),
          attendeeEmail,
          bookingRef,
        },
      });
    } else {
      // Free ticket order
      razorpayOrder = {
        orderId: `free_order_${Date.now()}`,
        amount: 0,
        currency,
        receipt: bookingRef,
        status: 'created',
        isSimulation: false,
      };
    }

    // 5. Save pending booking record in database
    const pendingBooking = db.createPendingBooking({
      bookingRef,
      eventId: event.id,
      eventTitle: event.title,
      eventDate: event.date,
      eventVenue: `${event.venue}, ${event.city}`,
      userId: userId || 'guest',
      userName: attendeeName,
      userEmail: attendeeEmail,
      userPhone: attendeePhone || '',
      tierId: tier.id,
      tierName: tier.name,
      quantity: ticketQty,
      unitPrice,
      discount: discountAmount,
      totalAmount,
      currency,
      paymentMethod: 'razorpay',
      razorpayOrderId: razorpayOrder.orderId,
    });

    const publicConfig = razorpayService.getPublicConfig();

    return res.status(201).json({
      success: true,
      bookingRef,
      orderId: razorpayOrder.orderId,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: publicConfig.keyId,
      isSimulation: razorpayOrder.isSimulation,
      calculatedDetails: {
        unitPrice,
        quantity: ticketQty,
        subtotal,
        discount: discountAmount,
        totalAmount,
      },
      booking: pendingBooking,
    });
  } catch (err) {
    console.error('[Create Order Error]', err);
    return res.status(500).json({ success: false, error: err.message || 'Server error creating order' });
  }
});

// ==============================================================================
// 4. Razorpay Signature Verification & Ticket Issuance
// ==============================================================================

/**
 * POST /api/payments/verify
 *
 * CRITICAL SECURITY RULE:
 * Issue a ticket ONLY after verified payment.
 * Computes HMAC-SHA256(order_id + "|" + payment_id, secret) on server.
 * If signature does not match, rejects immediately with 400.
 */
app.post('/api/payments/verify', (req, res) => {
  try {
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      bookingRef,
    } = req.body;

    if (!razorpayOrderId || !bookingRef) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: razorpayOrderId and bookingRef',
      });
    }

    // 1. Lookup pending booking in database
    const booking = db.getBookingByRef(bookingRef);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: `Booking reference ${bookingRef} not found in database`,
      });
    }

    // Check if orderId matches booking
    if (booking.razorpayOrderId !== razorpayOrderId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID mismatch for this booking reference',
      });
    }

    // If already confirmed (idempotency check)
    if (booking.bookingStatus === 'confirmed') {
      return res.json({
        success: true,
        verified: true,
        message: 'Booking was already verified and ticket issued.',
        booking,
      });
    }

    // Handle free tickets
    if (booking.totalAmount === 0) {
      const confirmedBooking = db.confirmPaymentAndIssueTicket({
        bookingRef,
        razorpayOrderId,
        razorpayPaymentId: 'FREE_ADMISSION',
        razorpaySignature: 'FREE_TICKET_APPROVED',
      });
      return res.json({
        success: true,
        verified: true,
        message: 'Free ticket confirmed and issued.',
        booking: confirmedBooking,
      });
    }

    // 2. Cryptographic signature verification
    const verificationResult = razorpayService.verifyPaymentSignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!verificationResult.verified) {
      console.warn(`[Security Alert] Payment signature verification failed for ${bookingRef}`);
      return res.status(400).json({
        success: false,
        verified: false,
        error: verificationResult.error || 'Invalid payment signature. Ticket issuance rejected.',
      });
    }

    // 3. ATOMIC CONFIRMATION & TICKET ISSUANCE IN DATABASE
    // Decrements seat count, generates Ticket ID, stores payment audit record
    const confirmedBooking = db.confirmPaymentAndIssueTicket({
      bookingRef,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    return res.json({
      success: true,
      verified: true,
      message: 'Payment signature verified successfully. E-ticket issued.',
      booking: confirmedBooking,
    });
  } catch (err) {
    console.error('[Verify Payment Error]', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error verifying payment',
    });
  }
});

// ==============================================================================
// 5. Booking Retrieval & Management Endpoints
// ==============================================================================

/**
 * Retrieve booking status and issued ticket by bookingRef
 */
app.get('/api/bookings/:bookingRef', (req, res) => {
  try {
    const booking = db.getBookingByRef(req.params.bookingRef);
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    return res.json({ success: true, booking });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Retrieve all bookings for a user
 */
app.get('/api/bookings/user/:userId', (req, res) => {
  try {
    const userBookings = db.getUserBookings(req.params.userId);
    return res.json({ success: true, count: userBookings.length, bookings: userBookings });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Cancel a booking and restore seat inventory
 */
app.post('/api/bookings/:id/cancel', (req, res) => {
  try {
    const updated = db.cancelBooking(req.params.id);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    return res.json({
      success: true,
      message: 'Booking cancelled and seats restored to inventory',
      booking: updated,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// 6. Razorpay Webhook Processing (Server-side & Idempotent)
// ==============================================================================

/**
 * POST /api/webhooks/razorpay
 *
 * Verifies webhook signature with x-razorpay-signature header.
 * Safely handles repeated/duplicate events idempotently.
 * Automatically confirms pending bookings if payment.captured or order.paid.
 */
app.post('/api/webhooks/razorpay', (req, res) => {
  try {
    const webhookSignature = req.headers['x-razorpay-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    const verification = razorpayService.verifyWebhookSignature({
      rawBody,
      webhookSignature,
    });

    if (!verification.verified) {
      console.warn('[Webhook Warning] Razorpay webhook signature verification failed:', verification.error);
      return res.status(400).json({ success: false, error: verification.error || 'Invalid webhook signature' });
    }

    const event = req.body.event || 'unknown';
    const eventId = req.body.event_id || req.headers['x-razorpay-event-id'] || `wh_${Date.now()}`;

    // 1. Check duplicate webhook event
    const record = db.recordWebhookEvent(eventId, event);
    if (record.isDuplicate) {
      console.log(`[Webhook Idempotency] Event ${eventId} was already processed. Returning 200 OK.`);
      return res.status(200).json({ success: true, message: 'Event already processed (idempotent)', eventId });
    }

    console.log(`[Webhook] Processing verified event: ${event} (ID: ${eventId})`);

    // 2. Handle payment events
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = req.body.payload?.payment?.entity;
      const orderEntity = req.body.payload?.order?.entity;

      const orderId = paymentEntity?.order_id || orderEntity?.id;
      const paymentId = paymentEntity?.id || `wh_pay_${Date.now()}`;
      const bookingRef = paymentEntity?.notes?.bookingRef || orderEntity?.receipt;

      let booking = null;
      if (bookingRef) {
        booking = db.getBookingByRef(bookingRef);
      } else if (orderId) {
        booking = db.getBookingByOrderId(orderId);
      }

      if (booking && booking.bookingStatus === 'pending') {
        const confirmed = db.confirmPaymentAndIssueTicket({
          bookingRef: booking.bookingRef,
          razorpayOrderId: orderId || booking.razorpayOrderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: 'WEBHOOK_VERIFIED',
        });
        console.log(`[Webhook Success] Auto-confirmed booking ${booking.bookingRef} via webhook event ${event}`);
        return res.status(200).json({ success: true, message: 'Booking confirmed via webhook', booking: confirmed });
      }
    }

    return res.status(200).json({ success: true, message: `Webhook ${event} acknowledged` });
  } catch (err) {
    console.error('[Webhook Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// 7. Ticket QR Code Verification & Gate Check-In Endpoints
// ==============================================================================

/**
 * POST /api/tickets/validate-qr
 * Validates a ticket QR payload or ticket code and returns its current status
 */
app.post('/api/tickets/validate-qr', (req, res) => {
  try {
    const { payloadOrCode } = req.body;
    if (!payloadOrCode) {
      return res.status(400).json({ success: false, error: 'payloadOrCode is required' });
    }

    const result = db.validateTicketQr(payloadOrCode);
    if (!result.valid) {
      return res.status(404).json({ success: false, ...result });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[QR Validation Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tickets/check-in
 * Performs gate check-in and prevents duplicate entry
 */
app.post('/api/tickets/check-in', (req, res) => {
  try {
    const { payloadOrCode, gateAgent } = req.body;
    if (!payloadOrCode) {
      return res.status(400).json({ success: false, error: 'payloadOrCode is required' });
    }

    const result = db.checkInTicket({ payloadOrCode, gateAgent });
    if (!result.success) {
      if (result.duplicate) {
        // Return 409 Conflict for duplicate entry attempt
        return res.status(409).json(result);
      }
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('[Gate Check-In Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// Start Server
// ==============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================================================');
  console.log(`🚀 EventForge Backend Server is running on port ${PORT}`);
  console.log(`🔗 API Base: http://localhost:${PORT}/api`);
  console.log(`🛡️  Razorpay Status: ${razorpayService.getStatus().notice}`);
  console.log('================================================================');
});

module.exports = app;
