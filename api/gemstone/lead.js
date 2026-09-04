const {
  cors, validLead, freshUpsert, freshCreateNote, buildLeadNote
} = require('../../lib/gemstone');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const lead = req.body || {};
    if (!validLead(lead)) {
      return res.status(400).json({ error: 'Please provide all required form fields.' });
    }

    const contact = await freshUpsert(lead);
    const note = await freshCreateNote(contact.id, buildLeadNote(lead));

    return res.status(200).json({
      ok: true,
      contact_id: contact.id || null,
      note_id: note.id || null
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Server error' });
  }
};
