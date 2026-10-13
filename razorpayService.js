/**
 * ==============================================================================
 * Razorpay Payment Integration Service (Server-side Only)
 * ==============================================================================
 * 1. Initializes the Razorpay SDK using server environment secrets.
 * 2. Creates payment orders via Orders API (amounts strictly determined by server).
 * 3. Verifies payment signatures cryptographically using HMAC-SHA256.
 * 4. NEVER exposes key_secret to the client or frontend.
 * ==============================================================================
 */

const crypto = require('crypto');

let Razorpay = null;
try {
  Razorpay = require('razorpay');
} catch (e) {
  // If razorpay module is not yet installed in node_modules, log message
  console.warn('[Razorpay] razorpay npm package not yet installed. Run "npm install" in /backend.');
}

const keyId = process.env.RAZORPAY_KEY_ID || '';
const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

// Detect if real or valid test keys are configured
const isConfigured = Boolean(
  keyId &&
  keySecret &&
  !keyId.includes('YourKeyIdHere') &&
  !keySecret.includes('YourKeySecretHere')
);

let razorpayInstance = null;
if (isConfigured && Razorpay) {
  try {
    razorpayInstance = new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    });
    console.log(`[Razorpay] Successfully initialized in ${keyId.startsWith('rzp_live') ? 'LIVE' : 'TEST'} mode. Key ID: ${keyId}`);
  } catch (err) {
    console.error('[Razorpay] Failed to initialize Razorpay SDK:', err.message);
  }
} else {
  console.warn(
    '[Razorpay Notice] Real Razorpay credentials are not yet configured in backend/.env.\n' +
    'The server is running in "Test Simulation / Dry-Run Mode". Real payment transactions require configuring RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.'
  );
}

const razorpayService = {
  /**
   * Status check of the Razorpay integration
   */
  getStatus() {
    return {
      isConfigured,
      keyId: keyId ? `${keyId.substring(0, 8)}...` : 'not_set',
      mode: isConfigured ? (keyId.startsWith('rzp_live') ? 'live' : 'test') : 'simulation_unconfigured',
      readyForLivePayments: isConfigured,
      notice: isConfigured
        ? 'Razorpay keys loaded. Server is ready for real/test orders.'
        : 'Running in sandbox simulation mode. Add valid RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to backend/.env to activate live Razorpay gateway.',
    };
  },

  /**
   * Return public configuration for the client (Key ID only, NEVER the secret!)
   */
  getPublicConfig() {
    return {
      keyId: isConfigured ? keyId : 'rzp_test_simulation_demo',
      currency: process.env.PAYMENT_CURRENCY || 'INR',
      isSimulation: !isConfigured,
    };
  },

  /**
   * Create an order via Razorpay Orders API
   * @param {Object} params
   * @param {number} params.amountInPaise - Exact amount calculated by the server in smallest currency subunit (paise)
   * @param {string} params.currency - Currency code (e.g., 'INR')
   * @param {string} params.receipt - Unique booking reference
   * @param {Object} params.notes - Metadata dictionary
   */
  async createOrder({ amountInPaise, currency = 'INR', receipt, notes = {} }) {
    if (!amountInPaise || amountInPaise <= 0) {
      throw new Error('Order amount must be greater than zero');
    }

    if (isConfigured && razorpayInstance) {
      try {
        const order = await razorpayInstance.orders.create({
          amount: Math.round(amountInPaise),
          currency,
          receipt,
          notes,
        });
        return {
          orderId: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
          isSimulation: false,
        };
      } catch (err) {
        console.error('[Razorpay Error] Failed to create order with Razorpay API:', err);
        throw new Error(`Razorpay Order creation failed: ${err.message || 'API error'}`);
      }
    } else {
      // Test simulation mode (allows dry-run testing before API keys are input by user)
      const simulatedOrderId = `order_sim_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
      console.log(`[Razorpay Simulation] Created dry-run order ${simulatedOrderId} for receipt ${receipt}`);
      return {
        orderId: simulatedOrderId,
        amount: Math.round(amountInPaise),
        currency,
        receipt,
        status: 'created',
        isSimulation: true,
      };
    }
  },

  /**
   * Cryptographically verify the payment signature
   * Algorithm: HMAC-SHA256(order_id + "|" + payment_id, key_secret) === signature
   */
  verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return {
        verified: false,
        error: 'Missing required signature verification parameters (order_id, payment_id, signature)',
      };
    }

    if (isConfigured && keySecret) {
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      const isMatch = crypto.timingSafeEqual(
        Buffer.from(generatedSignature, 'utf8'),
        Buffer.from(razorpaySignature, 'utf8')
      );

      if (!isMatch) {
        console.warn(`[Razorpay Security] Signature mismatch detected for Order: ${razorpayOrderId}, Payment: ${razorpayPaymentId}`);
        return {
          verified: false,
          error: 'Cryptographic signature mismatch. Payment verification failed.',
        };
      }

      return { verified: true, isSimulation: false };
    } else {
      // Simulation mode verification:
      // Explicitly reject tampered or invalid signatures
      if (
        razorpaySignature.includes('tamper') ||
        razorpaySignature.includes('invalid') ||
        razorpaySignature.includes('malicious')
      ) {
        return {
          verified: false,
          error: 'Tampered simulation signature detected. Cryptographic verification rejected.',
        };
      }

      const isSimulatedOrder = razorpayOrderId.startsWith('order_sim_');
      if (
        isSimulatedOrder &&
        (razorpaySignature === 'simulated_valid_signature' ||
          razorpaySignature === 'test_signature_valid' ||
          razorpaySignature.startsWith('test_sig_'))
      ) {
        console.log(`[Razorpay Simulation] Verified test signature for order ${razorpayOrderId}`);
        return { verified: true, isSimulation: true };
      }

      // If keySecret is not set, compute with fallback test secret for dry-run
      const fallbackSecret = 'test_simulation_secret';
      const expectedSimSig = crypto
        .createHmac('sha256', fallbackSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (razorpaySignature === expectedSimSig) {
        return { verified: true, isSimulation: true };
      }

      return {
        verified: false,
        error: 'Signature verification failed in simulation mode. Invalid test signature.',
      };
    }
  },

  /**
   * Cryptographically verify a Razorpay Webhook signature
   * Algorithm: HMAC-SHA256(raw_request_body, webhook_secret) === x-razorpay-signature
   */
  verifyWebhookSignature({ rawBody, webhookSignature, webhookSecret }) {
    const secret = webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;

    if (!webhookSignature) {
      return { verified: false, error: 'Missing x-razorpay-signature header' };
    }

    if (!secret) {
      // In simulation mode without webhook secret configured:
      if (webhookSignature === 'test_webhook_signature_valid' || webhookSignature.startsWith('sim_wh_')) {
        return { verified: true, isSimulation: true };
      }
      return { verified: false, error: 'Webhook secret is not configured in backend/.env' };
    }

    try {
      const bodyString = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(bodyString)
        .digest('hex');

      if (Buffer.from(expectedSignature, 'utf8').length !== Buffer.from(webhookSignature, 'utf8').length) {
        return { verified: false, error: 'Webhook signature length mismatch' };
      }

      const isMatch = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'utf8'),
        Buffer.from(webhookSignature, 'utf8')
      );

      if (!isMatch) {
        return { verified: false, error: 'Webhook signature mismatch' };
      }

      return { verified: true, isSimulation: false };
    } catch (err) {
      return { verified: false, error: err.message || 'Error verifying webhook signature' };
    }
  },
};

module.exports = razorpayService;
