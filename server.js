const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Configurations
const ALLOWED_ORIGIN = 'https://testfront.com'; // Restrict as requested
const API_KEY = process.env.MPAY_API_KEY || 'YOUR_API_KEY'; // API Key exists only in server.js
const MPAY_API_BASE = 'https://app.mpayafrica.site/api/v1';

// Setup CORS restricted to testfront.com (plus localhost for local developer testing)
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || origin === ALLOWED_ORIGIN || origin.includes('localhost') || origin.includes('127.0.0.1')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from the root (for index.html)
app.use(express.static(__dirname));

// Temporary memory storage for payment statuses
const paymentStore = new Map();

// Helper to generate transaction reference
function generateReference(countryCode) {
    const randomNum = Math.floor(100000 + Math.random() * 900000);
    return `TX-${countryCode}-${randomNum}`;
}

// Helper to get network and country name by code
function getNetworkInfo(countryCode) {
    switch (countryCode) {
        case 'KE': return { network: 'MPESA', name: 'Kenya' };
        case 'TZ': return { network: 'AIRTEL', name: 'Tanzania' };
        case 'ZM': return { network: 'MTN', name: 'Zambia' };
        case 'UG': return { network: 'AIRTEL', name: 'Uganda' };
        default: return { network: 'UNKNOWN', name: 'Unknown' };
    }
}

// 1. DEPOSIT API ENDPOINT
app.post('/deposit', async (req, res) => {
    try {
        const { phone_number, amount, country } = req.body;
        
        if (!phone_number || !amount || !country) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        if (amount < 10) {
            return res.status(400).json({ success: false, message: 'Minimum deposit is 10' });
        }

        const reference = generateReference(country);
        const { network, name } = getNetworkInfo(country);
        
        // Initialize payment state in memory
        paymentStore.set(reference, {
            status: 'PENDING',
            reference,
            phone_number,
            amount,
            country: name,
            network,
            date: new Date().toLocaleDateString(),
            time: new Date().toLocaleTimeString(),
            provider: 'M-Pay',
            message: 'Waiting for payment approval'
        });

        // The callback URL must be your actual server domain receiving the webhook
        const callbackUrl = `https://server.com/callback`; 

        // Initiate M-Pay STK Push
        const response = await axios.post(`${MPAY_API_BASE}/mpesa/express`, {
            api_key: API_KEY,
            amount: amount,
            phone_number: phone_number,
            user_reference: reference,
            payment_id: 1, // Channel identifier as requested
            callback_url: callbackUrl
        }, {
            headers: { 'Accept': 'application/json' }
        });

        if (response.data && response.data.message) {
            res.json({
                success: true,
                message: 'Payment initiated successfully',
                reference: reference
            });
        } else {
            paymentStore.set(reference, { ...paymentStore.get(reference), status: 'FAILED', message: 'Failed to initiate payment' });
            res.status(400).json({ success: false, message: 'Failed to initiate payment', reference });
        }

    } catch (error) {
        console.error('Deposit Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// 2. CREATE CALLBACK ENDPOINT
app.post('/callback', (req, res) => {
    const data = req.body;
    console.log('M-Pay Callback Received:', data);
    
    // Extract reference depending on M-Pay webhook structure
    const reference = data.user_reference || data.reference || (data.data && data.data.user_reference);
    const isSuccess = data.success === true || data.status === 'SUCCESS' || data.ResultCode === 0 || data.ResultCode === '0';

    if (reference && paymentStore.has(reference)) {
        const payment = paymentStore.get(reference);
        payment.status = isSuccess ? 'SUCCESS' : 'FAILED';
        payment.message = isSuccess ? 'Payment received successfully' : 'Payment failed or cancelled';
        
        // Update in-memory store
        paymentStore.set(reference, payment);
    }
    
    // Always return success response to M-Pay to acknowledge receipt
    res.json({ success: true });
});

// 3. FRONTEND PAYMENT STATUS CHECK
app.get('/status/:reference', (req, res) => {
    const { reference } = req.params;
    
    if (paymentStore.has(reference)) {
        res.json({ success: true, data: paymentStore.get(reference) });
    } else {
        res.status(404).json({ success: false, message: 'Transaction not found' });
    }
});

// 4. WITHDRAW API SUPPORT
app.post('/withdraw', async (req, res) => {
    try {
        const { amount, receiver_number, channel_code, payment_reference } = req.body;

        if (!amount || !receiver_number || !channel_code) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const callbackUrl = `https://server.com/callback`;

        // Map payload as application/x-www-form-urlencoded as shown in the cURL example
        const response = await axios.post(`${MPAY_API_BASE}/withdraw`, new URLSearchParams({
            Amount: amount,
            ReceiverNumber: receiver_number,
            ChannelCode: channel_code,
            PaymentReference: payment_reference || `INV-${Date.now()}`,
            CallbackURL: callbackUrl
        }), {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        res.json(response.data);

    } catch (error) {
        console.error('Withdraw Error:', error.response ? error.response.data : error.message);
        res.status(error.response ? error.response.status : 500).json({
            success: false,
            message: error.response && error.response.data ? error.response.data.message : 'Internal Server Error'
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
