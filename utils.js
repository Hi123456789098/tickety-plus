const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('./config');

function baseEmbed() {
  return new EmbedBuilder().setColor(config.defaults.embedColor).setFooter({ text: config.brand.footer });
}

function successEmbed(description) {
  return baseEmbed().setColor(config.defaults.successColor).setDescription(description);
}

function errorEmbed(description) {
  return baseEmbed().setColor(config.defaults.dangerColor).setDescription(description);
}

function warnEmbed(description) {
  return baseEmbed().setColor(config.defaults.warnColor).setDescription(description);
}

function isOwner(userId) {
  return config.ownerIds.includes(userId);
}

function isStaff(member, guildSettings) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (guildSettings?.support_role_id && member.roles.cache.has(guildSettings.support_role_id)) return true;
  return isOwner(member.id);
}

const transcriptsDir = path.join(__dirname, '..', 'transcripts');
if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetches full message history for a channel and writes a searchable,
 * static HTML transcript to disk. Returns the absolute file path.
 */
async function generateTranscript(channel, ticket) {
  let allMessages = [];
  let lastId;
  // Discord only returns 100 messages per call, page backwards through history.
  // (fetch() typing: pass {limit, before})
  for (;;) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    allMessages = allMessages.concat(Array.from(batch.values()));
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  allMessages.reverse();

  const rows = allMessages
    .map((m) => {
      const time = new Date(m.createdTimestamp).toLocaleString();
      const author = escapeHtml(m.author?.tag || 'Unknown');
      const content = escapeHtml(m.content || '').replace(/\n/g, '<br>');
      const attachments = Array.from(m.attachments?.values() || [])
        .map((a) => `<div class="attachment"><a href="${a.url}" target="_blank">${escapeHtml(a.name)}</a></div>`)
        .join('');
      return `<div class="msg"><span class="author">${author}</span><span class="time">${time}</span><div class="content">${content}${attachments}</div></div>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Transcript - #${escapeHtml(channel.name)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#313338; color:#dbdee1; margin:0; padding:24px; }
  h1 { color:#f2f3f5; font-size:20px; }
  .meta { color:#949ba4; font-size:13px; margin-bottom:16px; }
  .msg { padding:8px 0; border-bottom:1px solid #3f4147; }
  .author { font-weight:600; color:#f2f3f5; margin-right:8px; }
  .time { color:#949ba4; font-size:12px; }
  .content { margin-top:4px; white-space:pre-wrap; word-break:break-word; }
  .attachment { margin-top:4px; }
  .attachment a { color:#00a8fc; }
</style></head><body>
<h1>Transcript for #${escapeHtml(channel.name)}</h1>
<div class="meta">Ticket #${ticket.id} &middot; Category: ${escapeHtml(ticket.category)} &middot; Opened by user ID ${escapeHtml(ticket.user_id)} &middot; Generated ${new Date().toLocaleString()}</div>
${rows || '<p>No messages.</p>'}
</body></html>`;

  const fileName = `ticket-${ticket.id}-${Date.now()}.html`;
  const filePath = path.join(transcriptsDir, fileName);
  fs.writeFileSync(filePath, html, 'utf-8');
  return filePath;
}

module.exports = {
  baseEmbed,
  successEmbed,
  errorEmbed,
  warnEmbed,
  isOwner,
  isStaff,
  generateTranscript,
  transcriptsDir,
};
