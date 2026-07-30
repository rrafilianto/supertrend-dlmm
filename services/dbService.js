const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'positions.json');

/**
 * Memuat seluruh data posisi dari file JSON lokal.
 */
function loadPositions() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initialData = { positions: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
      return initialData;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading DB_FILE:', err);
    return { positions: [] };
  }
}

/**
 * Menyimpan seluruh data posisi ke file JSON lokal.
 */
function savePositions(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing DB_FILE:', err);
  }
}

/**
 * Menambahkan posisi baru berstatus ACTIVE.
 */
function addPosition(pos) {
  const db = loadPositions();
  pos.maxPnlPct = pos.maxPnlPct || 0;
  pos.maxPrice = pos.maxPrice || pos.entryPrice;
  db.positions.push(pos);
  savePositions(db);
  return pos;
}

/**
 * Mengambil semua posisi yang saat ini berstatus ACTIVE.
 */
function getActivePositions() {
  const db = loadPositions();
  return db.positions.filter(p => p.status === 'ACTIVE');
}

/**
 * Mengupdate puncak PnL dan harga tertinggi yang pernah dicapai posisi.
 */
function updatePositionPeak(id, maxPrice, maxPnlPct) {
  const db = loadPositions();
  const idx = db.positions.findIndex(p => p.id === id);
  if (idx !== -1) {
    db.positions[idx].maxPrice = maxPrice;
    db.positions[idx].maxPnlPct = maxPnlPct;
    savePositions(db);
    return db.positions[idx];
  }
  return null;
}

/**
 * Mengupdate status dan metadata penutupan posisi (misal: CLOSED_TP / CLOSED_SL / CLOSED_TRAILING_STOP).
 */
function updatePositionStatus(id, newStatus, closeDetails = {}) {
  const db = loadPositions();
  const idx = db.positions.findIndex(p => p.id === id);
  if (idx !== -1) {
    db.positions[idx].status = newStatus;
    db.positions[idx].closedAt = new Date().toISOString();
    db.positions[idx].closeDetails = closeDetails;
    savePositions(db);
    return db.positions[idx];
  }
  return null;
}

module.exports = {
  loadPositions,
  savePositions,
  addPosition,
  getActivePositions,
  updatePositionPeak,
  updatePositionStatus,
};
