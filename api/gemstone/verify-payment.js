const {
  cors, validLead, freshUpdateNote, buildLeadNote,
  sendWatiTemplate, verifyRazorpaySignature
} = require('../../lib/gemstone');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      lead,
      consultation,
      amount,
      contact_id,
      note_id
    } = req.body || {};

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature ||
        !validLead(lead) || !contact_id || !note_id || !consultation || !amount) {
      return res.status(400).json({ error: 'Incomplete payment verification data.' });
    }

    if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ error: 'Payment signature verification failed.' });
    }

    await freshUpdateNote(
      note_id,
      contact_id,
      buildLeadNote(lead, {
        consultation,
        amount,
        paymentStatus: 'Paid',
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id
      })
    );

    let wati = { skipped: true };
    try {
      wati = await sendWatiTemplate(lead, consultation, amount, razorpay_payment_id);
    } catch (error) {
      console.error(error.message);
      wati = { skipped: false, error: error.message };
    }

    return res.status(200).json({
      ok: true,
      contact_id,
      note_id,
      payment_id: razorpay_payment_id,
      wati
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
