const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'tickety.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  verified_role_id TEXT,
  verify_channel_id TEXT,
  log_channel_id TEXT,
  transcript_channel_id TEXT,
  support_role_id TEXT,
  ticket_category_id TEXT,
  auto_close_hours INTEGER DEFAULT 48,
  sla_warning_minutes INTEGER DEFAULT 30,
  ticket_counter INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ticket_panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  title TEXT,
  categories TEXT -- JSON array of {key,label,emoji,description}
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT UNIQUE,
  user_id TEXT,
  category TEXT,
  status TEXT DEFAULT 'open', -- open | claimed | closed
  priority TEXT DEFAULT 'normal', -- low | normal | high | urgent
  claimed_by TEXT,
  tags TEXT DEFAULT '[]', -- JSON array of strings
  rating INTEGER,
  transcript_path TEXT,
  first_staff_reply_at INTEGER,
  opened_at INTEGER,
  claimed_at INTEGER,
  closed_at INTEGER,
  closed_by TEXT,
  last_activity_at INTEGER
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  user_id TEXT,
  role_key TEXT,
  role_label TEXT,
  answers TEXT, -- JSON array of {question, answer}
  status TEXT DEFAULT 'pending', -- pending | approved | denied
  reviewed_by TEXT,
  review_message_id TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS application_panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  role_key TEXT,
  role_label TEXT,
  approve_role_id TEXT,
  review_channel_id TEXT,
  questions TEXT -- JSON array of strings, max 5 (modal limit)
);

CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  prize TEXT,
  winners_count INTEGER,
  required_role_id TEXT,
  end_at INTEGER,
  ended INTEGER DEFAULT 0,
  entrants TEXT DEFAULT '[]',
  winners TEXT DEFAULT '[]',
  host_id TEXT
);

CREATE TABLE IF NOT EXISTS macros (
  guild_id TEXT,
  name TEXT,
  content TEXT,
  created_by TEXT,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS blacklist (
  guild_id TEXT,
  user_id TEXT,
  reason TEXT,
  added_by TEXT,
  added_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS faq_panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  entries TEXT -- JSON array of {question, answer, emoji}
);
`);

function getGuildSettings(guildId) {
  let row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!row) {
    db.prepare(
      'INSERT INTO guild_settings (guild_id, auto_close_hours, sla_warning_minutes, ticket_counter) VALUES (?, 48, 30, 0)'
    ).run(guildId);
    row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  }
  return row;
}

function updateGuildSettings(guildId, fields) {
  getGuildSettings(guildId); // ensure row exists
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`UPDATE guild_settings SET ${setClause} WHERE guild_id = ?`).run(...values, guildId);
}

function nextTicketNumber(guildId) {
  getGuildSettings(guildId);
  db.prepare('UPDATE guild_settings SET ticket_counter = ticket_counter + 1 WHERE guild_id = ?').run(guildId);
  return db.prepare('SELECT ticket_counter FROM guild_settings WHERE guild_id = ?').get(guildId).ticket_counter;
}

module.exports = {
  db,
  getGuildSettings,
  updateGuildSettings,
  nextTicketNumber,
};
