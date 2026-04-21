const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Hardcoded LworxPay Credentials (replace before production) ──────────────
const LWORXPAY_API_KEY     = 'HReEITtwMf2SutaThlyZG37cJwIj';
const LWORXPAY_MERCHANT_ID = 'NiThTzsBSYNo';
const LWORXPAY_API_SECRET  = 'JIIPI9PNOCaOjAP6XxMTcObdMqfgwX7REQUwTj';
const LWORXPAY_BASE_URL    = 'https://lworx.ug-web.com/api/v1';
// ─────────────────────────────────────────────────────────────────────────────

// Allow any frontend to connect
app.use(cors({ origin: '*' }));
app.use(express.json());

// Store in-memory pending transactions { trx_id: { amount, phone, reference, ... } }
const pendingTransactions = {};

// ─── Helper: build a receipt object ──────────────────────────────────────────
function buildReceipt({ status, trx_id, phone, amount, fee, net_amount, currency, reference, message, created_at, updated_at, timestamp }) {
    const now = new Date().toISOString();
    const isSuccess = status === 'success' || status === 'completed';

    return {
        receipt: {
            status_badge: isSuccess ? '✅ PAYMENT SUCCESSFUL' : '❌ PAYMENT FAILED',
            status,
            trx_id:     trx_id     || null,
            phone:      phone      || null,
            amount:     amount     || null,
            fee:        fee        || null,
            net_amount: net_amount || null,
            currency:   currency   || 'UGX',
            reference:  reference  || null,
            message:    message    || (isSuccess ? 'Payment completed successfully.' : 'Payment failed or was not approved.'),
            created_at: created_at || now,
            updated_at: updated_at || now,
            timestamp:  timestamp  || Math.floor(Date.now() / 1000),
            powered_by: 'LworxPay — Uganda Mobile Money'
        }
    };
}

// ─── POST /pay — Initiate STK push ───────────────────────────────────────────
// Body: { phone, amount, description?, reference? }
app.post('/pay', async (req, res) => {
    const { phone, amount, description, reference } = req.body;

    if (!phone || !amount) {
        return res.status(400).json({
            success: false,
            error: 'phone and amount are required.'
        });
    }

    const ref = reference || `TXN-${Date.now()}`;

    // Build the webhook URL pointing back to this server
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const ipn_url = `${protocol}://${host}/webhook/lworxpay`;

    try {
        const lworxRes = await fetch(`${LWORXPAY_BASE_URL}/direct-charge`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LWORXPAY_API_KEY}`,
                'Content-Type':  'application/json'
            },
            body: JSON.stringify({
                phone,
                amount:      Number(amount),
                currency:    'UGX',
                description: description || `Payment of ${amount} UGX`,
                reference:   ref,
                ipn_url
            })
        });

        const data = await lworxRes.json();

        if (!data.success) {
            return res.status(400).json({
                success: false,
                error: data.error || 'Failed to initiate payment.',
                raw: data
            });
        }

        // Cache transaction info for receipt building later
        pendingTransactions[data.trx_id] = {
            trx_id:    data.trx_id,
            phone,
            amount:    data.amount,
            fee:       data.fee,
            net_amount:data.net_amount,
            currency:  data.currency || 'UGX',
            reference: data.reference || ref,
            status:    'pending'
        };

        return res.json({
            success:    true,
            message:    data.message,
            trx_id:     data.trx_id,
            amount:     data.amount,
            fee:        data.fee,
            net_amount: data.net_amount,
            currency:   data.currency || 'UGX',
            reference:  data.reference || ref,
            status:     'pending',
            status_url: data.status_url,
            info:       'Customer should approve the prompt on their phone within 60 seconds.'
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            error: 'Server error while contacting LworxPay.',
            detail: err.message
        });
    }
});

// ─── GET /status/:trx_id — Poll payment status + return full receipt ──────────
app.get('/status/:trx_id', async (req, res) => {
    const { trx_id } = req.params;

    try {
        const lworxRes = await fetch(`${LWORXPAY_BASE_URL}/charge-status/${trx_id}`, {
            headers: {
                'Authorization': `Bearer ${LWORXPAY_API_KEY}`
            }
        });

        const data = await lworxRes.json();

        // Merge with any cached transaction info
        const cached = pendingTransactions[trx_id] || {};
        const combined = { ...cached, ...data };

        // Update cache if terminal status
        if (data.status === 'success' || data.status === 'failed') {
            if (pendingTransactions[trx_id]) {
                pendingTransactions[trx_id].status = data.status;
            }
        }

        const receipt = buildReceipt({
            status:     combined.status,
            trx_id:     combined.trx_id || trx_id,
            phone:      combined.phone,
            amount:     combined.amount,
            fee:        combined.fee,
            net_amount: combined.net_amount,
            currency:   combined.currency || 'UGX',
            reference:  combined.reference,
            created_at: combined.created_at,
            updated_at: combined.updated_at
        });

        return res.json({
            success: data.success !== false,
            ...receipt,
            raw_status: data.status
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            error: 'Server error while checking payment status.',
            detail: err.message
        });
    }
});

// ─── POST /webhook/lworxpay — Receive webhook from LworxPay ──────────────────
app.post('/webhook/lworxpay', (req, res) => {
    const rawBody  = JSON.stringify(req.body);
    const signature = req.headers['x-signature'];

    // Verify HMAC-SHA256 signature
    const expected = crypto.createHmac('sha256', LWORXPAY_API_SECRET)
        .update(rawBody)
        .digest('hex');

    if (signature && signature !== expected) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body;
    const status  = payload.status;

    // Extract reference (works for both Direct Charge and Payment Link)
    const reference = (payload.data && (payload.data.ext_reference || payload.data.ref_trx)) || null;
    const phone     = (payload.data && payload.data.phone) || null;

    // Build a full receipt from the webhook payload
    const txCached = reference
        ? Object.values(pendingTransactions).find(t => t.reference === reference)
        : null;

    const receipt = buildReceipt({
        status,
        trx_id:     txCached ? txCached.trx_id : null,
        phone:      phone || (txCached ? txCached.phone : null),
        amount:     txCached ? txCached.amount : null,
        fee:        txCached ? txCached.fee : null,
        net_amount: txCached ? txCached.net_amount : null,
        currency:   (txCached ? txCached.currency : null) || 'UGX',
        reference,
        message:    payload.message,
        timestamp:  payload.timestamp
    });

    // Log for debugging
    console.log('[WEBHOOK]', JSON.stringify({ status, reference, receipt }));

    // Always return 200 immediately
    res.status(200).json({ status: 'ok', ...receipt });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`LworxPay Uganda payments server running on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST /pay              — initiate STK push (body: { phone, amount, description?, reference? })`);
    console.log(`  GET  /status/:trx_id  — poll payment status + full receipt`);
    console.log(`  POST /webhook/lworxpay — LworxPay webhook receiver`);
});
