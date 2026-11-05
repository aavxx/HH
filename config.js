// Edit everything in this file to match the salon.
module.exports = {
  name: 'Studio Lumière',
  stylist: 'Your Name',
  tagline: 'Cuts, colour and styling that fit your life.',
  about:
    'I opened this studio to give every client one-to-one time in a calm space. ' +
    'Every appointment starts with a proper consultation, so you leave with hair that suits you ' +
    'and that you can actually style at home.',
  phone: '+1 (555) 123-4567',
  email: 'hello@example.com',
  address: '123 Main Street, Your City',
  instagram: '', // e.g. 'https://instagram.com/yourhandle' (leave empty to hide)

  // IANA time zone of the salon. Used to block past time slots.
  timezone: 'America/New_York',
  currency: 'USD',

  // Booking rules
  slotMinutes: 30,       // start times are offered every N minutes
  leadMinutes: 60,       // minimum notice for same-day bookings
  maxDaysAhead: 60,      // how far ahead clients can book

  // null = closed that day. Times are 24h "HH:MM".
  hours: {
    sun: null,
    mon: null,
    tue: { open: '09:00', close: '18:00' },
    wed: { open: '09:00', close: '18:00' },
    thu: { open: '10:00', close: '20:00' },
    fri: { open: '09:00', close: '18:00' },
    sat: { open: '09:00', close: '16:00' },
  },

  // id must be unique and never change once bookings exist.
  services: [
    { id: 'womens-cut', name: "Women's cut & style", minutes: 60, price: 65, description: 'Consultation, wash, precision cut and blow-dry.' },
    { id: 'mens-cut', name: "Men's cut", minutes: 30, price: 35, description: 'Clipper or scissor cut, wash and style.' },
    { id: 'kids-cut', name: 'Kids cut (under 12)', minutes: 30, price: 25, description: 'Quick, friendly cut for little ones.' },
    { id: 'blowout', name: 'Blow-dry & style', minutes: 45, price: 45, description: 'Wash and a smooth or voluminous finish.' },
    { id: 'root-colour', name: 'Root colour', minutes: 90, price: 85, description: 'Single-process colour on regrowth.' },
    { id: 'full-colour', name: 'Full colour', minutes: 120, price: 120, description: 'All-over colour, includes cut & finish.' },
    { id: 'balayage', name: 'Balayage / highlights', minutes: 180, price: 180, description: 'Hand-painted or foil highlights, toner and finish.' },
    { id: 'treatment', name: 'Deep conditioning treatment', minutes: 30, price: 30, description: 'Repair mask for dry or damaged hair.' },
  ],

  policies: [
    'Please arrive 5 minutes early. Arriving more than 15 minutes late may mean rescheduling.',
    'Need to cancel or move your appointment? Call or email at least 24 hours ahead.',
    'Colour clients new to the studio may need a patch test 48 hours before their appointment.',
    'Prices are a starting point and can vary with hair length and thickness.',
  ],
};
