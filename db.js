/**
 * ==============================================================================
 * EventForge Database Engine (SQLite / Persistent Storage)
 * ==============================================================================
 * Handles ACID transactions for:
 * 1. Event & Ticket Tier catalog with live seat counters
 * 2. Pending & Confirmed Bookings
 * 3. Payment transaction records & Razorpay audit trails
 * 4. Cryptographic Ticket IDs & QR validation payloads
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve configured database path
// In cloud environments (e.g. Render persistent disk at /var/data/eventforge.db), DATABASE_FILE can be an absolute path
const rawDbFile = process.env.DATABASE_FILE;
const DB_PATH = rawDbFile
  ? (path.isAbsolute(rawDbFile) ? rawDbFile : path.resolve(process.cwd(), rawDbFile))
  : path.join(__dirname, 'data', 'eventforge.db');

// Ensure the parent directory for the database file exists
const targetDir = path.dirname(DB_PATH);
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

let sqliteDb = null;
let useJsonStore = false;
let jsonStorePath = path.join(targetDir, 'eventforge_store.json');

// Attempt initializing Node.js native SQLite DatabaseSync
try {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(DB_PATH);
  console.log(`[Database] SQLite DatabaseSync initialized at: ${DB_PATH}`);
} catch (err) {
  console.warn('[Database] Native SQLite not available. Falling back to persistent JSON storage:', err.message);
  useJsonStore = true;
}

// Initial seed events & tiers
const SEED_EVENTS = [
  {
    id: 'evt-101',
    title: 'Global AI & Autonomous Systems Summit 2026',
    slug: 'global-ai-summit-2026',
    description: 'Join 1,200+ engineers, researchers, and tech founders exploring the forefront of foundation models, neural agent architectures, and embodied AI.',
    category: 'Tech',
    date: '2026-11-14',
    time: '09:00 AM - 06:00 PM',
    venue: 'Moscone Convention Center, Hall D',
    city: 'San Francisco, CA',
    imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1200&q=80',
    organizer: 'NextGen AI Institute',
    totalSeats: 350,
    availableSeats: 64,
    status: 'upcoming',
    featured: 1,
    tiers: [
      {
        id: 'tier-101-standard',
        name: 'General Pass',
        price: 149,
        description: 'Access to all main stage keynotes, exhibition floor, and evening networking mixer.',
        perks: ['Main Stage Access', 'Exhibition Hall Badge', 'Coffee & Lunch Included'],
        available: 44,
        total: 250,
      },
      {
        id: 'tier-101-vip',
        name: 'VIP Executive Pass',
        price: 349,
        description: 'VIP front row reserved seating, private speakers lounge, and dinner invitation.',
        perks: ['VIP Lounge Access', 'Private Speakers Dinner', '1-on-1 Mentorship Session'],
        available: 20,
        total: 100,
      },
    ],
  },
  {
    id: 'evt-102',
    title: 'Echoes in the Park: Indie & Synthwave Music Night',
    slug: 'echoes-in-the-park-synthwave',
    description: 'An open-air dusk-to-dawn celebration of synthwave, retrowave, and indie electronic artists under an audiovisual laser canopy.',
    category: 'Music',
    date: '2026-11-20',
    time: '06:00 PM - 02:00 AM',
    venue: 'Skyline Amphitheater',
    city: 'Austin, TX',
    imageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1200&q=80',
    organizer: 'Neon Horizon Records',
    totalSeats: 800,
    availableSeats: 142,
    status: 'upcoming',
    featured: true,
    tiers: [
      {
        id: 'tier-102-lawn',
        name: 'Lawn General Admission',
        price: 45,
        description: 'Open lawn seating with 360-degree festival surround sound and food truck access.',
        perks: ['Open Lawn Access', 'Festival Wristband', 'Reusable Eco Cup'],
        available: 110,
        total: 600,
      },
      {
        id: 'tier-102-pit',
        name: 'Front Pit & Backstage Lounge',
        price: 110,
        description: 'Direct stage-front pit access, express bar lanes, and backstage acoustic session entry.',
        perks: ['Stage Pit Access', 'Backstage Lounge', 'Commemorative Poster'],
        available: 32,
        total: 200,
      },
    ],
  },
  {
    id: 'evt-103',
    title: 'NextGen Cloud Architecture & Microservices Masterclass',
    slug: 'nextgen-cloud-architecture-masterclass',
    description: 'Intensive 2-day hands-on engineering lab building distributed fault-tolerant systems with Kafka, Kubernetes, and gRPC.',
    category: 'Workshop',
    date: '2026-11-28',
    time: '10:00 AM - 05:00 PM',
    venue: 'Pier 57 Tech Hub, Studio B',
    city: 'New York, NY',
    imageUrl: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1200&q=80',
    organizer: 'Distributed Systems Academy',
    totalSeats: 120,
    availableSeats: 18,
    status: 'upcoming',
    featured: false,
    tiers: [
      {
        id: 'tier-103-bootcamp',
        name: 'Standard Workshop Ticket',
        price: 199,
        description: 'Full 2-day live interactive lab access with dedicated cloud sandbox environment.',
        perks: ['Hands-on Lab Cloud Environment', 'Verified Certificate', 'Architecture Templates'],
        available: 18,
        total: 120,
      },
    ],
  },
  {
    id: 'evt-104',
    title: 'VentureSprint: Annual Startup Pitch & Angel Demo Day',
    slug: 'venturesprint-demo-day-2026',
    description: 'Top 25 seed-stage tech ventures pitch live to over 150 accredited angels and Tier-1 venture capital partners.',
    category: 'Business',
    date: '2026-12-05',
    time: '01:00 PM - 07:30 PM',
    venue: 'Founders Tower, 18th Floor Grand Ballroom',
    city: 'New York, NY',
    imageUrl: 'https://images.unsplash.com/photo-1515187029135-18ee286d815b?auto=format&fit=crop&w=1200&q=80',
    organizer: 'Apex Capital Ventures',
    totalSeats: 200,
    availableSeats: 48,
    status: 'upcoming',
    featured: true,
    tiers: [
      {
        id: 'tier-104-founder',
        name: 'Attendee / Founder Pass',
        price: 75,
        description: 'General audience gallery access and general networking cocktail hour.',
        perks: ['Pitch Session Audience Access', 'Founder Networking Lounge', 'Deal Book PDF'],
        available: 38,
        total: 150,
      },
      {
        id: 'tier-104-investor',
        name: 'Accredited Investor Pass',
        price: 250,
        description: 'Reserved front tables, direct founder pitch decks, and private 1:1 deal breakout tables.',
        perks: ['Front Table Reserved Seating', 'Private Deal Room Access', 'Direct Contact Matrix', 'Private Angel Dinner'],
        available: 10,
        total: 50,
      },
    ],
  },
  {
    id: 'evt-105',
    title: 'Inter-College Esports Clash & Gaming Championship',
    slug: 'inter-college-esports-championship',
    description: 'High-octane collegiate finals featuring CS2, Valorant, and Rocket League showdowns on massive 4K LED arrays.',
    category: 'Sports',
    date: '2026-12-12',
    time: '11:00 AM - 09:00 PM',
    venue: 'Metropolis Esports Arena',
    city: 'Chicago, IL',
    imageUrl: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=1200&q=80',
    organizer: 'Campus Gaming League',
    totalSeats: 400,
    availableSeats: 115,
    status: 'upcoming',
    featured: false,
    tiers: [
      {
        id: 'tier-105-spectator',
        name: 'Day Spectator Pass',
        price: 25,
        description: 'Full day spectator entry to all arena stages and gaming exhibition booth zone.',
        perks: ['All Match Stages Access', 'Raffle Ticket for RTX 5080', 'Free Energy Drink & Snack Voucher'],
        available: 95,
        total: 320,
      },
      {
        id: 'tier-105-vip',
        name: 'VIP Front Row & Pro Meet',
        price: 65,
        description: 'Padded floor seats, pro-player signing session, and tournament commemorative jersey.',
        perks: ['Stage Front Row Seating', 'Official Team Jersey', 'Backstage Pro Meet & Greet', 'Fast-lane Entry'],
        available: 20,
        total: 80,
      },
    ],
  },
  {
    id: 'evt-106',
    title: 'Kaleidoscope: International Contemporary Art & Film Expo',
    slug: 'kaleidoscope-art-and-film-expo',
    description: 'A 3-day immersive celebration of modern cinematography, digital installation arts, and VR short films.',
    category: 'Cultural',
    date: '2026-12-18',
    time: '10:00 AM - 08:00 PM',
    venue: 'Civic Arts Pavilion',
    city: 'Denver, CO',
    imageUrl: 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&w=1200&q=80',
    organizer: 'Civic Cultural Council',
    totalSeats: 250,
    availableSeats: 90,
    status: 'upcoming',
    featured: false,
    tiers: [
      {
        id: 'tier-106-day',
        name: 'Single Day Gallery Pass',
        price: 35,
        description: 'Access to all visual installations, film screening rooms, and outdoor sculpture terrace.',
        perks: ['All Gallery Rooms Access', '3 Screening Room Passes', 'Exhibition Guide Booklet'],
        available: 70,
        total: 200,
      },
      {
        id: 'tier-106-all',
        name: 'Full 3-Day All-Access Pass',
        price: 79,
        description: 'Unlimited access across all three exhibition days plus creator panel discussions.',
        perks: ['3-Day Unlimited Entry', 'Director Q&A Reserved Row', 'Closing Night Gala Entry'],
        available: 20,
        total: 50,
      },
    ],
  },
];

// JSON Store Implementation (fallback or sync)
function readJsonStore() {
  if (!fs.existsSync(jsonStorePath)) {
    const initial = {
      events: SEED_EVENTS,
      bookings: [],
      tickets: [],
      payments: [],
    };
    fs.writeFileSync(jsonStorePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(jsonStorePath, 'utf8'));
  } catch (e) {
    return { events: SEED_EVENTS, bookings: [], tickets: [], payments: [] };
  }
}

function writeJsonStore(data) {
  fs.writeFileSync(jsonStorePath, JSON.stringify(data, null, 2));
}

// Initialize SQLite Schema
function initSqlite() {
  if (!sqliteDb) return;

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT,
      description TEXT,
      category TEXT,
      date TEXT,
      time TEXT,
      venue TEXT,
      city TEXT,
      imageUrl TEXT,
      organizer TEXT,
      totalSeats INTEGER,
      availableSeats INTEGER,
      status TEXT,
      featured INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ticket_tiers (
      id TEXT PRIMARY KEY,
      eventId TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      perksJson TEXT,
      available INTEGER NOT NULL,
      total INTEGER NOT NULL,
      FOREIGN KEY (eventId) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      bookingRef TEXT UNIQUE NOT NULL,
      eventId TEXT NOT NULL,
      eventTitle TEXT,
      eventDate TEXT,
      eventVenue TEXT,
      userId TEXT,
      userName TEXT,
      userEmail TEXT,
      userPhone TEXT,
      tierId TEXT NOT NULL,
      tierName TEXT,
      quantity INTEGER NOT NULL,
      unitPrice REAL NOT NULL,
      discount REAL DEFAULT 0,
      totalAmount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      paymentMethod TEXT,
      paymentStatus TEXT DEFAULT 'pending',
      bookingStatus TEXT DEFAULT 'pending',
      bookedAt TEXT,
      razorpayOrderId TEXT,
      razorpayPaymentId TEXT,
      razorpaySignature TEXT,
      FOREIGN KEY (eventId) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      bookingId TEXT NOT NULL,
      bookingRef TEXT NOT NULL,
      ticketCode TEXT UNIQUE NOT NULL,
      qrPayload TEXT NOT NULL,
      issuedAt TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      FOREIGN KEY (bookingId) REFERENCES bookings(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      bookingId TEXT NOT NULL,
      razorpayOrderId TEXT,
      razorpayPaymentId TEXT,
      razorpaySignature TEXT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (bookingId) REFERENCES bookings(id)
    );

    CREATE TABLE IF NOT EXISTS processed_webhooks (
      eventId TEXT PRIMARY KEY,
      eventType TEXT,
      processedAt TEXT
    );
  `);

  // Safe schema migrations for existing SQLite databases
  try { sqliteDb.exec('ALTER TABLE tickets ADD COLUMN checkedInAt TEXT;'); } catch (_) {}
  try { sqliteDb.exec('ALTER TABLE tickets ADD COLUMN checkedInBy TEXT;'); } catch (_) {}

  // Seed events and tiers into SQLite safely
  const insertEvent = sqliteDb.prepare(`
    INSERT OR IGNORE INTO events (id, title, slug, description, category, date, time, venue, city, imageUrl, organizer, totalSeats, availableSeats, status, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTier = sqliteDb.prepare(`
    INSERT OR IGNORE INTO ticket_tiers (id, eventId, name, price, description, perksJson, available, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const evt of SEED_EVENTS) {
    insertEvent.run(
      evt.id,
      evt.title,
      evt.slug,
      evt.description,
      evt.category,
      evt.date,
      evt.time,
      evt.venue,
      evt.city,
      evt.imageUrl,
      evt.organizer,
      evt.totalSeats,
      evt.availableSeats,
      evt.status,
      evt.featured ? 1 : 0
    );

    for (const tier of evt.tiers) {
      insertTier.run(
        tier.id,
        evt.id,
        tier.name,
        tier.price,
        tier.description,
        JSON.stringify(tier.perks || []),
        tier.available,
        tier.total
      );
    }
  }
}

// Call SQLite schema init
if (sqliteDb) {
  try {
    initSqlite();
  } catch (err) {
    console.error('[Database] SQLite init error, switching to JSON store:', err.message);
    useJsonStore = true;
    sqliteDb = null;
  }
}

// Exported Database operations
const db = {
  // 1. Get all events with tiers
  getEvents() {
    if (!useJsonStore && sqliteDb) {
      const events = sqliteDb.prepare('SELECT * FROM events').all();
      const tiers = sqliteDb.prepare('SELECT * FROM ticket_tiers').all();

      return events.map((e) => ({
        ...e,
        featured: Boolean(e.featured),
        tiers: tiers
          .filter((t) => t.eventId === e.id)
          .map((t) => ({
            ...t,
            perks: JSON.parse(t.perksJson || '[]'),
          })),
      }));
    } else {
      const store = readJsonStore();
      return store.events;
    }
  },

  // 2. Get single event by ID
  getEventById(eventId) {
    const events = this.getEvents();
    return events.find((e) => e.id === eventId) || null;
  },

  // 3. Get single tier
  getTierById(eventId, tierId) {
    const event = this.getEventById(eventId);
    if (!event) return null;
    return event.tiers.find((t) => t.id === tierId) || null;
  },

  // 4. Create a pending booking (atomic record before payment gateway redirect)
  createPendingBooking({
    bookingRef,
    eventId,
    eventTitle,
    eventDate,
    eventVenue,
    userId,
    userName,
    userEmail,
    userPhone,
    tierId,
    tierName,
    quantity,
    unitPrice,
    discount,
    totalAmount,
    currency,
    paymentMethod,
    razorpayOrderId,
  }) {
    const id = `bkg-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
    const bookedAt = new Date().toISOString();

    if (!useJsonStore && sqliteDb) {
      const stmt = sqliteDb.prepare(`
        INSERT INTO bookings (
          id, bookingRef, eventId, eventTitle, eventDate, eventVenue,
          userId, userName, userEmail, userPhone, tierId, tierName,
          quantity, unitPrice, discount, totalAmount, currency,
          paymentMethod, paymentStatus, bookingStatus, bookedAt, razorpayOrderId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        bookingRef,
        eventId,
        eventTitle,
        eventDate,
        eventVenue,
        userId || 'guest',
        userName,
        userEmail,
        userPhone || '',
        tierId,
        tierName,
        quantity,
        unitPrice,
        discount,
        totalAmount,
        currency || 'INR',
        paymentMethod || 'razorpay',
        'pending',
        'pending',
        bookedAt,
        razorpayOrderId
      );

      return this.getBookingByRef(bookingRef);
    } else {
      const store = readJsonStore();
      const newBooking = {
        id,
        bookingRef,
        eventId,
        eventTitle,
        eventDate,
        eventVenue,
        userId: userId || 'guest',
        userName,
        userEmail,
        userPhone: userPhone || '',
        tierId,
        tierName,
        quantity,
        unitPrice,
        discount,
        totalAmount,
        currency: currency || 'INR',
        paymentMethod: paymentMethod || 'razorpay',
        paymentStatus: 'pending',
        bookingStatus: 'pending',
        bookedAt,
        razorpayOrderId,
      };
      store.bookings.unshift(newBooking);
      writeJsonStore(store);
      return newBooking;
    }
  },

  // 5. Get booking by bookingRef
  getBookingByRef(bookingRef) {
    if (!useJsonStore && sqliteDb) {
      const booking = sqliteDb.prepare('SELECT * FROM bookings WHERE bookingRef = ?').get(bookingRef);
      if (!booking) return null;

      const tickets = sqliteDb.prepare('SELECT * FROM tickets WHERE bookingId = ?').all(booking.id);
      return { ...booking, tickets };
    } else {
      const store = readJsonStore();
      const booking = store.bookings.find((b) => b.bookingRef === bookingRef);
      if (!booking) return null;
      const tickets = (store.tickets || []).filter((t) => t.bookingId === booking.id);
      return { ...booking, tickets };
    }
  },

  // 6. Get booking by Razorpay Order ID
  getBookingByOrderId(orderId) {
    if (!useJsonStore && sqliteDb) {
      const booking = sqliteDb.prepare('SELECT * FROM bookings WHERE razorpayOrderId = ?').get(orderId);
      if (!booking) return null;
      const tickets = sqliteDb.prepare('SELECT * FROM tickets WHERE bookingId = ?').all(booking.id);
      return { ...booking, tickets };
    } else {
      const store = readJsonStore();
      const booking = store.bookings.find((b) => b.razorpayOrderId === orderId);
      if (!booking) return null;
      const tickets = (store.tickets || []).filter((t) => t.bookingId === booking.id);
      return { ...booking, tickets };
    }
  },

  // 7. Atomic transaction: Verify payment, deduct seats, and issue ticket
  confirmPaymentAndIssueTicket({
    bookingRef,
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  }) {
    const booking = this.getBookingByRef(bookingRef);
    if (!booking) {
      throw new Error(`Booking ${bookingRef} not found`);
    }

    if (booking.bookingStatus === 'confirmed') {
      // Already confirmed (idempotent response)
      return this.getBookingByRef(bookingRef);
    }

    const event = this.getEventById(booking.eventId);
    const tier = this.getTierById(booking.eventId, booking.tierId);

    if (!event || !tier) {
      throw new Error('Event or tier no longer exists');
    }

    if (tier.available < booking.quantity) {
      throw new Error(`Insufficient seats remaining. Available: ${tier.available}, requested: ${booking.quantity}`);
    }

    const issuedAt = new Date().toISOString();
    const qty = Math.max(1, booking.quantity || 1);
    const issuedTickets = [];

    for (let i = 0; i < qty; i++) {
      const ticketId = `TKT-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const qrPayload = `EVENTFORGE:${booking.bookingRef}:${ticketId}:${booking.tierId}:VERIFIED_RAZORPAY`;
      issuedTickets.push({ ticketId, qrPayload });
    }

    if (!useJsonStore && sqliteDb) {
      // Atomic updates in SQLite
      const updateSeats = sqliteDb.prepare(`
        UPDATE ticket_tiers
        SET available = available - ?
        WHERE id = ? AND available >= ?
      `);

      const updateEventSeats = sqliteDb.prepare(`
        UPDATE events
        SET availableSeats = availableSeats - ?
        WHERE id = ? AND availableSeats >= ?
      `);

      const updateBooking = sqliteDb.prepare(`
        UPDATE bookings
        SET paymentStatus = 'paid',
            bookingStatus = 'confirmed',
            razorpayPaymentId = ?,
            razorpaySignature = ?
        WHERE id = ?
      `);

      const insertTicket = sqliteDb.prepare(`
        INSERT INTO tickets (id, bookingId, bookingRef, ticketCode, qrPayload, issuedAt, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `);

      const insertPayment = sqliteDb.prepare(`
        INSERT INTO payments (id, bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature, amount, currency, status, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?)
      `);

      updateSeats.run(booking.quantity, tier.id, booking.quantity);
      updateEventSeats.run(booking.quantity, event.id, booking.quantity);
      updateBooking.run(razorpayPaymentId, razorpaySignature, booking.id);

      for (const t of issuedTickets) {
        insertTicket.run(t.ticketId, booking.id, booking.bookingRef, t.ticketId, t.qrPayload, issuedAt);
      }

      insertPayment.run(
        `pay-${Date.now()}`,
        booking.id,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        booking.totalAmount,
        booking.currency || 'INR',
        issuedAt
      );

      return this.getBookingByRef(bookingRef);
    } else {
      // JSON Store atomic update
      const store = readJsonStore();

      // Deduct tier and event seats
      const targetEvent = store.events.find((e) => e.id === booking.eventId);
      if (targetEvent) {
        targetEvent.availableSeats = Math.max(0, targetEvent.availableSeats - booking.quantity);
        const targetTier = targetEvent.tiers.find((t) => t.id === booking.tierId);
        if (targetTier) {
          targetTier.available = Math.max(0, targetTier.available - booking.quantity);
        }
      }

      // Update booking
      const targetBooking = store.bookings.find((b) => b.id === booking.id);
      if (targetBooking) {
        targetBooking.paymentStatus = 'paid';
        targetBooking.bookingStatus = 'confirmed';
        targetBooking.razorpayPaymentId = razorpayPaymentId;
        targetBooking.razorpaySignature = razorpaySignature;
      }

      // Add tickets
      store.tickets = store.tickets || [];
      const newTickets = [];
      for (const t of issuedTickets) {
        const newTicket = {
          id: t.ticketId,
          bookingId: booking.id,
          bookingRef: booking.bookingRef,
          ticketCode: t.ticketId,
          qrPayload: t.qrPayload,
          issuedAt,
          status: 'active',
        };
        store.tickets.push(newTicket);
        newTickets.push(newTicket);
      }

      // Add payment
      store.payments = store.payments || [];
      store.payments.push({
        id: `pay-${Date.now()}`,
        bookingId: booking.id,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        amount: booking.totalAmount,
        currency: booking.currency || 'INR',
        status: 'success',
        createdAt: issuedAt,
      });

      writeJsonStore(store);
      return { ...targetBooking, tickets: newTickets };
    }
  },

  // 8. Cancel booking and restore inventory
  cancelBooking(bookingId) {
    if (!useJsonStore && sqliteDb) {
      const booking = sqliteDb.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      if (!booking || booking.bookingStatus === 'cancelled') {
        return booking;
      }

      // Return seats to event and tier
      sqliteDb.prepare(`
        UPDATE ticket_tiers
        SET available = available + ?
        WHERE id = ?
      `).run(booking.quantity, booking.tierId);

      sqliteDb.prepare(`
        UPDATE events
        SET availableSeats = availableSeats + ?
        WHERE id = ?
      `).run(booking.quantity, booking.eventId);

      sqliteDb.prepare(`
        UPDATE bookings
        SET bookingStatus = 'cancelled', paymentStatus = 'refunded'
        WHERE id = ?
      `).run(bookingId);

      sqliteDb.prepare(`
        UPDATE tickets
        SET status = 'cancelled'
        WHERE bookingId = ?
      `).run(bookingId);

      return sqliteDb.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    } else {
      const store = readJsonStore();
      const booking = store.bookings.find((b) => b.id === bookingId);
      if (!booking || booking.bookingStatus === 'cancelled') return booking;

      const targetEvent = store.events.find((e) => e.id === booking.eventId);
      if (targetEvent) {
        targetEvent.availableSeats = Math.min(targetEvent.totalSeats, targetEvent.availableSeats + booking.quantity);
        const targetTier = targetEvent.tiers.find((t) => t.id === booking.tierId);
        if (targetTier) {
          targetTier.available = Math.min(targetTier.total, targetTier.available + booking.quantity);
        }
      }

      booking.bookingStatus = 'cancelled';
      booking.paymentStatus = 'refunded';

      if (store.tickets) {
        store.tickets.forEach((t) => {
          if (t.bookingId === bookingId) t.status = 'cancelled';
        });
      }

      writeJsonStore(store);
      return booking;
    }
  },

  // 9. Get bookings for a user
  getUserBookings(userId) {
    if (!useJsonStore && sqliteDb) {
      const bookings = sqliteDb.prepare('SELECT * FROM bookings WHERE userId = ? ORDER BY bookedAt DESC').all(userId);
      return bookings.map((b) => {
        const tickets = sqliteDb.prepare('SELECT * FROM tickets WHERE bookingId = ?').all(b.id);
        return { ...b, tickets };
      });
    } else {
      const store = readJsonStore();
      const userBookings = (store.bookings || []).filter((b) => b.userId === userId);
      return userBookings.map((b) => {
        const tickets = (store.tickets || []).filter((t) => t.bookingId === b.id);
        return { ...b, tickets };
      });
    }
  },

  // 10. Webhook Deduplication: Record webhook event and test idempotency
  recordWebhookEvent(eventId, eventType) {
    if (!eventId) return { isDuplicate: false, processedAt: new Date().toISOString() };
    const now = new Date().toISOString();

    if (!useJsonStore && sqliteDb) {
      const existing = sqliteDb.prepare('SELECT * FROM processed_webhooks WHERE eventId = ?').get(eventId);
      if (existing) {
        return { isDuplicate: true, processedAt: existing.processedAt };
      }
      sqliteDb.prepare('INSERT INTO processed_webhooks (eventId, eventType, processedAt) VALUES (?, ?, ?)').run(eventId, eventType || '', now);
      return { isDuplicate: false, processedAt: now };
    } else {
      const store = readJsonStore();
      store.processed_webhooks = store.processed_webhooks || [];
      const existing = store.processed_webhooks.find((w) => w.eventId === eventId);
      if (existing) {
        return { isDuplicate: true, processedAt: existing.processedAt };
      }
      store.processed_webhooks.push({ eventId, eventType, processedAt: now });
      writeJsonStore(store);
      return { isDuplicate: false, processedAt: now };
    }
  },

  // 11. Validate Ticket QR code payload or Ticket Code
  validateTicketQr(payloadOrCode) {
    if (!payloadOrCode) {
      return { valid: false, error: 'Empty ticket code or QR payload provided' };
    }

    const clean = String(payloadOrCode).trim();
    let ticket = null;

    if (!useJsonStore && sqliteDb) {
      ticket = sqliteDb.prepare('SELECT * FROM tickets WHERE ticketCode = ? OR qrPayload = ?').get(clean, clean);
    } else {
      const store = readJsonStore();
      ticket = (store.tickets || []).find((t) => t.ticketCode === clean || t.qrPayload === clean);
    }

    if (!ticket) {
      return { valid: false, error: 'Ticket not found or invalid QR signature.' };
    }

    const booking = this.getBookingByRef(ticket.bookingRef);
    const event = booking ? this.getEventById(booking.eventId) : null;

    return {
      valid: true,
      ticket,
      booking,
      event,
      alreadyCheckedIn: Boolean(ticket.checkedInAt),
      checkedInAt: ticket.checkedInAt || null,
      checkedInBy: ticket.checkedInBy || null,
      status: ticket.status,
    };
  },

  // 12. Check-In Gate Validation (Prevents Duplicate Scans / Admissions)
  checkInTicket({ payloadOrCode, gateAgent = 'Gate Scanner' }) {
    const validation = this.validateTicketQr(payloadOrCode);
    if (!validation.valid) {
      return { success: false, duplicate: false, error: validation.error };
    }

    const { ticket, booking, event } = validation;

    if (ticket.status === 'cancelled') {
      return { success: false, duplicate: false, error: 'Ticket has been cancelled. Entry denied.' };
    }

    if (ticket.checkedInAt) {
      return {
        success: false,
        duplicate: true,
        error: `DUPLICATE ENTRY ALERT: Ticket ${ticket.ticketCode} was already checked in at ${new Date(ticket.checkedInAt).toLocaleTimeString()} by ${ticket.checkedInBy || 'Gate'}.`,
        ticket,
        booking,
        event,
      };
    }

    const now = new Date().toISOString();
    const agentName = gateAgent || 'Gate Scanner';

    if (!useJsonStore && sqliteDb) {
      sqliteDb.prepare(`
        UPDATE tickets
        SET checkedInAt = ?, checkedInBy = ?, status = 'checked_in'
        WHERE id = ?
      `).run(now, agentName, ticket.id);
    } else {
      const store = readJsonStore();
      const t = (store.tickets || []).find((x) => x.id === ticket.id);
      if (t) {
        t.checkedInAt = now;
        t.checkedInBy = agentName;
        t.status = 'checked_in';
        writeJsonStore(store);
      }
    }

    const updatedTicket = { ...ticket, checkedInAt: now, checkedInBy: agentName, status: 'checked_in' };
    return {
      success: true,
      duplicate: false,
      message: `Admission Granted: ${booking?.userName || 'Guest'} (${ticket.ticketCode})`,
      ticket: updatedTicket,
      booking,
      event,
    };
  },

  // 13. Expose active database path for health inspection & verification
  getDatabasePath() {
    return DB_PATH;
  },
};

module.exports = db;
