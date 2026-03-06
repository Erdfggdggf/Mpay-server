const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Configurations
const ALLOWED_ORIGIN = 'https://mpay-stk-frontend.onrender.com';
const API_KEY = process.env.MPAY_API_KEY || 'aoJw4jz9TkFOQ62ZyoQsJQ0TKfwzr67JzTrtIZG3s85liR4Ft697DMFeLq7N';
const MPAY_API_BASE = 'https://app.mpayafrica.site/api/v1';

// Setup CORS - set to '*' as requested to fix network errors
app.use(cors({
    origin: '*'
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

// Helper to get country name by code
function getCountryName(countryCode) {
    switch (countryCode) {
        case 'KE': return 'Kenya';
        case 'TZ': return 'Tanzania';
        case 'ZM': return 'Zambia';
        case 'UG': return 'Uganda';
        default: return 'Unknown';
    }
}

// 1. DEPOSIT API ENDPOINT
app.post('/deposit', async (req, res) => {
    try {
        const { phone_number, amount, country, network } = req.body;
        
        if (!phone_number || !amount || !country || !network) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Validate minimum deposit based on country
        let minAmount = 10;
        if (country === 'UG') minAmount = 15000;
        else if (country === 'TZ') minAmount = 2500;
        else if (country === 'ZM') minAmount = 100;
        else if (country === 'KE') minAmount = 10;

        if (amount < minAmount) {
            return res.status(400).json({ success: false, message: `Minimum deposit for ${country} is ${minAmount}` });
        }

        const reference = generateReference(country);
        const name = getCountryName(country);
        
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

        const callbackUrl = `https://mpay-server-xxts.onrender.com/callback`; 

        let response;
        if (country !== 'KE' || network !== 'MPESA') {
            // Use Global Payments API for non-Kenyan countries OR non-MPESA Kenyan networks
            response = await axios.post('https://app.mpayafrica.site/api/global-payments', {
                api_key: API_KEY,
                first_name: "Customer",
                last_name: "Deposit",
                email: "customer@example.com",
                phone: phone_number.startsWith('+') ? phone_number : `+${phone_number}`,
                amount: parseFloat(amount),
                country_code: country,
                network_code: network,
                reason: "Deposit via mpay",
                ramp_type: "deposit",
                callback_url: callbackUrl,
                reference: reference
            }, {
                headers: { 
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });
        } else {
            // Use M-Pesa Express for Kenya MPESA
            response = await axios.post(`${MPAY_API_BASE}/mpesa/express`, new URLSearchParams({
                api_key: API_KEY,
                amount: amount.toString(),
                phone_number: phone_number,
                user_reference: reference,
                payment_id: 'wallet',
                callback_url: callbackUrl
            }), {
                headers: { 
                    'Accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
        }

        if (response.data && (response.data.message || response.data.success || response.data.status === 'success')) {
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
        console.error('========== DEPOSIT ERROR ==========');
        if (error.response) {
            console.error('Data:', error.response.data);
            console.error('Status:', error.response.status);
            console.error('Headers:', error.response.headers);
        } else if (error.request) {
            console.error('No response received (Request details):', error.request);
        } else {
            console.error('Error setting up request:', error.message);
        }
        if (error.config) console.error('Axios Config:', error.config);
        console.error('===================================');

        const errorDetails = error.response ? error.response.data : error.message;
        res.status(500).json({ 
            success: false, 
            message: 'Internal Server Error',
            details: errorDetails
        });
    }
});

// 2. CREATE CALLBACK ENDPOINT
app.post('/callback', (req, res) => {
    const data = req.body;
    console.log('M-Pay Callback Received:', data);
    
    const reference = data.user_reference || data.reference || (data.data && data.data.user_reference);
    const isSuccess = data.success === true || data.status === 'SUCCESS' || data.status === 'success' || data.ResultCode === 0 || data.ResultCode === '0';

    if (reference && paymentStore.has(reference)) {
        const payment = paymentStore.get(reference);
        payment.status = isSuccess ? 'SUCCESS' : 'FAILED';
        payment.message = isSuccess ? 'Payment received successfully' : 'Payment failed or cancelled';
        paymentStore.set(reference, payment);
    }
    
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

        const callbackUrl = `https://mpay-server-xxts.onrender.com/callback`;

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
        console.error('========== WITHDRAW ERROR ==========');
        if (error.response) {
            console.error('Data:', error.response.data);
            console.error('Status:', error.response.status);
            console.error('Headers:', error.response.headers);
        } else if (error.request) {
            console.error('No response received (Request details):', error.request);
        } else {
            console.error('Error setting up request:', error.message);
        }
        if (error.config) console.error('Axios Config:', error.config);
        console.error('====================================');

        res.status(error.response ? error.response.status : 500).json({
            success: false,
            message: error.response && error.response.data ? error.response.data.message : 'Internal Server Error'
        });
    }
});

// Global Error Handlers for better logging in Render
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
