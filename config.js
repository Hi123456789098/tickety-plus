require('dotenv').config();

function parseList(value) {
  return (value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  devGuildId: process.env.DEV_GUILD_ID || null,
  ownerIds: parseList(process.env.OWNER_IDS),
  dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),

  // Tunable defaults - all of these are also overridable per-guild via
  // /settings, these are just the fallbacks used when a guild hasn't
  // configured them yet.
  defaults: {
    autoCloseHours: 48, // close inactive tickets with no activity for this long
    slaWarningMinutes: 30, // ping staff if a new ticket has no staff reply within this window
    ticketNameTemplate: 'ticket-{count}',
    embedColor: 0x5865f2,
    successColor: 0x57f287,
    dangerColor: 0xed4245,
    warnColor: 0xfee75c,
  },

  brand: {
    name: 'Tickety+',
    footer: 'Tickety+ - open-source ticket system',
  },
};
