const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── LworxPay Credentials ─────────────────────────────────────────────────────
const LWORXPAY_API_KEY     = 'HReEITtwMf2SutaThlyZG37cJwIj';
const LWORXPAY_MERCHANT_ID = 'NiThTzsBSYNo';
const LWORXPAY_API_SECRET  = 'JIIPI9PNOCaOjAP6XxMTcObdMqfgwX7REQUwTj';
const LWORXPAY_BASE_URL    = 'https://lworx.ug-web.com/api/v1';
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json());

// In-memory transaction cache  { trx_id -> { phone, amount, fee, net_amount, currency, reference } }
const pendingTransactions = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildReceipt({ status, trx_id, phone, amount, fee, net_amount, currency, reference, message, created_at, updated_at, timestamp }) {
    const now      = new Date().toISOString();
    const isSuccess = status === 'success' || status === 'completed';
    return {
        receipt: {
            status_badge: isSuccess ? '✅ PAYMENT SUCCESSFUL' : '❌ PAYMENT FAILED',
            status,
            trx_id:     trx_id     || null,
            phone:      phone      || null,
            amount:     amount     || null,
            fee:        fee        !== undefined ? fee : null,
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

async function lworxFetch(url, options = {}) {
    const res  = await fetch(url, options);
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, data: { error: text } }; }
}

// ─── GET /health — Confirm server & credentials are loaded ────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:     'ok',
        server:     'LworxPay Uganda Payments',
        node:       process.version,
        api_key_preview:    LWORXPAY_API_KEY.slice(0, 6) + '…' + LWORXPAY_API_KEY.slice(-4),
        merchant_id: LWORXPAY_MERCHANT_ID,
        base_url:   LWORXPAY_BASE_URL,
        uptime_sec: Math.floor(process.uptime())
    });
});

// ─── POST /pay — Initiate STK push ───────────────────────────────────────────
// Body: { phone, amount, description?, reference? }
app.post('/pay', async (req, res) => {
    const { phone, amount, description, reference } = req.body || {};

    if (!phone || !amount) {
        return res.status(400).json({ success: false, error: 'phone and amount are required.' });
    }
    if (Number(amount) < 500) {
        return res.status(400).json({ success: false, error: 'Minimum amount is 500 UGX.' });
    }

    const ref = reference || `TXN-${Date.now()}`;

    const host     = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    const ipn_url  = `${protocol}://${host}/webhook/lworxpay`;

    const payload = {
        phone,
        amount:      Number(amount),
        currency:    'UGX',
        description: description || `Payment of ${Number(amount).toLocaleString()} UGX`,
        reference:   ref,
        ipn_url
    };

    console.log('[PAY] Sending to LworxPay:', JSON.stringify({ ...payload, _key_preview: LWORXPAY_API_KEY.slice(0,6) + '…' }));

    try {
        const { ok, status: httpStatus, data } = await lworxFetch(`${LWORXPAY_BASE_URL}/direct-charge`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${LWORXPAY_API_KEY}`,
                'Content-Type':  'application/json'
            },
            body: JSON.stringify(payload)
        });

        console.log('[PAY] LworxPay response:', httpStatus, JSON.stringify(data));

        if (!data.success) {
            return res.status(400).json({
                success: false,
                error:   data.error || data.message || 'Failed to initiate payment.',
                raw:     data
            });
        }

        pendingTransactions[data.trx_id] = {
            trx_id:     data.trx_id,
            phone,
            amount:     data.amount,
            fee:        data.fee,
            net_amount: data.net_amount,
            currency:   data.currency || 'UGX',
            reference:  data.reference || ref,
            status:     'pending'
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
        console.error('[PAY] Error:', err.message);
        return res.status(500).json({ success: false, error: 'Server error contacting LworxPay.', detail: err.message });
    }
});

// ─── GET /status/:trx_id — Poll status + return full receipt ─────────────────
app.get('/status/:trx_id', async (req, res) => {
    const { trx_id } = req.params;

    try {
        const { data } = await lworxFetch(`${LWORXPAY_BASE_URL}/charge-status/${trx_id}`, {
            headers: { 'Authorization': `Bearer ${LWORXPAY_API_KEY}` }
        });

        const cached   = pendingTransactions[trx_id] || {};
        const combined = { ...cached, ...data };

        if (data.status === 'success' || data.status === 'failed') {
            if (pendingTransactions[trx_id]) pendingTransactions[trx_id].status = data.status;
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

        return res.json({ success: data.success !== false, ...receipt, raw_status: data.status });

    } catch (err) {
        return res.status(500).json({ success: false, error: 'Server error checking status.', detail: err.message });
    }
});

// ─── POST /webhook/lworxpay — LworxPay webhook ───────────────────────────────
app.post('/webhook/lworxpay', (req, res) => {
    const rawBody   = JSON.stringify(req.body);
    const signature = req.headers['x-signature'];

    if (signature) {
        const expected = crypto.createHmac('sha256', LWORXPAY_API_SECRET).update(rawBody).digest('hex');
        if (signature !== expected) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }

    const payload   = req.body;
    const status    = payload.status;
    const reference = (payload.data && (payload.data.ext_reference || payload.data.ref_trx)) || null;
    const phone     = (payload.data && payload.data.phone) || null;
    const txCached  = reference ? Object.values(pendingTransactions).find(t => t.reference === reference) : null;

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

    console.log('[WEBHOOK]', JSON.stringify({ status, reference, receipt }));
    res.status(200).json({ status: 'ok', ...receipt });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ LworxPay Uganda server running — port ${PORT}`);
    console.log(`   API key: ${LWORXPAY_API_KEY.slice(0, 6)}…${LWORXPAY_API_KEY.slice(-4)}`);
    console.log(`   Merchant: ${LWORXPAY_MERCHANT_ID}`);
    console.log(`   Base URL: ${LWORXPAY_BASE_URL}`);
});
