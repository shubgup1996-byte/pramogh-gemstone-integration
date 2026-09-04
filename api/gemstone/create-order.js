const {
  cors, validLead, freshUpdateNote, buildLeadNote,
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
} = require('../../lib/gemstone');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      throw new Error('Razorpay credentials are not configured on Vercel.');
    }

    const { amount, consultation, lead, contact_id, note_id } = req.body || {};
    if (!Number.isInteger(amount) || amount <= 0 || !consultation || !validLead(lead) || !contact_id || !note_id) {
      return res.status(400).json({ error: 'Invalid payment request.' });
    }

    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: 'INR',
        receipt: `gemstone_${Date.now()}`,
        notes: {
          consultation,
          phone: String(lead.phone || '').replace(/\D/g, '')
        }
      })
    });

    const order = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Razorpay error (${response.status}): ${JSON.stringify(order)}`);
    }

    await freshUpdateNote(
      note_id,
      contact_id,
      buildLeadNote(lead, {
        consultation,
        amount,
        paymentStatus: 'Payment Pending',
        orderId: order.id
      })
    );

    return res.status(200).json({
      id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
