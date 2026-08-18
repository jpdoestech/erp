const db = require('./database');

function logAction(userId, action, entityType, entityId, details) {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId || null, action, entityType, entityId || null, details || null);
}

module.exports = { logAction };
