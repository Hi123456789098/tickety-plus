const { ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, getGuildSettings, nextTicketNumber } = require('../database');
const { baseEmbed, successEmbed, errorEmbed, generateTranscript } = require('../utils');

const PRIORITY_LABELS = {
  low: { label: 'Low', emoji: '🟢' },
  normal: { label: 'Normal', emoji: '🔵' },
  high: { label: 'High', emoji: '🟠' },
  urgent: { label: 'Urgent', emoji: '🔴' },
};

function controlRow(ticket) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_claim_${ticket.id}`)
      .setLabel(ticket.claimed_by ? 'Claimed' : 'Claim')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!!ticket.claimed_by),
    new ButtonBuilder().setCustomId(`ticket_close_${ticket.id}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_priority_${ticket.id}`).setLabel('Set Priority').setStyle(ButtonStyle.Secondary)
  );
  return row;
}

async function createTicket(interaction, categoryConfig) {
  const { guild, user } = interaction;
  const settings = getGuildSettings(guild.id);

  // Blacklist check
  const blocked = db.prepare('SELECT * FROM blacklist WHERE guild_id = ? AND user_id = ?').get(guild.id, user.id);
  if (blocked) {
    return interaction.reply({
      embeds: [errorEmbed(`You are blacklisted from creating tickets. Reason: ${blocked.reason || 'not specified'}`)],
      ephemeral: true,
    });
  }

  // Prevent duplicate open tickets in the same category
  const existing = db
    .prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND category = ? AND status != 'closed'")
    .get(guild.id, user.id, categoryConfig.key);
  if (existing) {
    return interaction.reply({
      embeds: [errorEmbed(`You already have an open ticket: <#${existing.channel_id}>`)],
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const number = nextTicketNumber(guild.id);
  const channelName = `ticket-${number}`;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
    },
  ];
  if (settings.support_role_id) {
    overwrites.push({
      id: settings.support_role_id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: settings.ticket_category_id || undefined,
    permissionOverwrites: overwrites,
    topic: `Ticket #${number} | Category: ${categoryConfig.label} | Opened by ${user.tag} (${user.id})`,
  });

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO tickets (guild_id, channel_id, user_id, category, status, priority, tags, opened_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'open', 'normal', '[]', ?, ?)`
    )
    .run(guild.id, channel.id, user.id, categoryConfig.key, now, now);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);

  const embed = baseEmbed()
    .setTitle(`Ticket #${number} - ${categoryConfig.label}`)
    .setDescription(
      `Thanks for reaching out, ${user}!\n\n${categoryConfig.description || 'A team member will be with you shortly.'}\n\nUse the buttons below to manage this ticket.`
    )
    .addFields({ name: 'Priority', value: `${PRIORITY_LABELS.normal.emoji} Normal`, inline: true });

  await channel.send({
    content: settings.support_role_id ? `<@&${settings.support_role_id}> · ${user}` : `${user}`,
    embeds: [embed],
    components: [controlRow(ticket)],
  });

  if (settings.log_channel_id) {
    const logChannel = guild.channels.cache.get(settings.log_channel_id);
    if (logChannel) {
      logChannel
        .send({ embeds: [successEmbed(`🎫 Ticket **#${number}** opened by ${user} in ${channel} (category: ${categoryConfig.label})`)] })
        .catch(() => {});
    }
  }

  await interaction.editReply({ embeds: [successEmbed(`Your ticket has been created: ${channel}`)] });
  return ticket;
}

async function claimTicket(interaction, ticketId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return interaction.reply({ embeds: [errorEmbed('Ticket not found.')], ephemeral: true });
  if (ticket.claimed_by) {
    return interaction.reply({ embeds: [errorEmbed(`Already claimed by <@${ticket.claimed_by}>.`)], ephemeral: true });
  }
  db.prepare("UPDATE tickets SET claimed_by = ?, claimed_at = ?, status = 'claimed' WHERE id = ?").run(
    interaction.user.id,
    Date.now(),
    ticketId
  );
  await interaction.reply({ embeds: [successEmbed(`${interaction.user} claimed this ticket.`)] });
  const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  const msg = await interaction.channel.messages.fetch(interaction.message.id).catch(() => null);
  if (msg) await msg.edit({ components: [controlRow(updated)] }).catch(() => {});
}

async function markFirstStaffReply(message, settings) {
  // Called from messageCreate handler; only relevant inside ticket channels.
  const ticket = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status != 'closed'").get(message.channel.id);
  if (!ticket) return;
  db.prepare('UPDATE tickets SET last_activity_at = ? WHERE id = ?').run(Date.now(), ticket.id);
  if (!ticket.first_staff_reply_at && message.author.id !== ticket.user_id && !message.author.bot) {
    db.prepare('UPDATE tickets SET first_staff_reply_at = ? WHERE id = ?').run(Date.now(), ticket.id);
  }
}

async function closeTicket(interaction, ticketId, { reason } = {}) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return interaction.reply({ embeds: [errorEmbed('Ticket not found.')], ephemeral: true });
  if (ticket.status === 'closed') {
    return interaction.reply({ embeds: [errorEmbed('This ticket is already closed.')], ephemeral: true });
  }

  await interaction.reply({ embeds: [successEmbed('Closing ticket and generating transcript...')] });

  const channel = interaction.channel;
  const settings = getGuildSettings(interaction.guild.id);
  let transcriptPath = null;
  try {
    transcriptPath = await generateTranscript(channel, ticket);
  } catch (err) {
    console.error('Transcript generation failed:', err);
  }

  db.prepare(
    "UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, transcript_path = ? WHERE id = ?"
  ).run(Date.now(), interaction.user.id, transcriptPath, ticketId);

  if (settings.transcript_channel_id) {
    const logChannel = interaction.guild.channels.cache.get(settings.transcript_channel_id);
    if (logChannel) {
      const files = transcriptPath ? [{ attachment: transcriptPath, name: `ticket-${ticket.id}-transcript.html` }] : [];
      logChannel
        .send({
          embeds: [
            baseEmbed()
              .setTitle(`Transcript - Ticket #${ticket.id}`)
              .addFields(
                { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
                { name: 'Closed by', value: `${interaction.user}`, inline: true },
                { name: 'Category', value: ticket.category, inline: true },
                { name: 'Reason', value: reason || 'Not specified' }
              ),
          ],
          files,
        })
        .catch(() => {});
    }
  }

  // Ask the ticket opener to rate the support they received.
  try {
    const opener = await interaction.client.users.fetch(ticket.user_id);
    const row = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map((n) =>
        new ButtonBuilder().setCustomId(`rate_${ticket.id}_${n}`).setLabel('⭐'.repeat(n)).setStyle(ButtonStyle.Secondary)
      )
    );
    await opener.send({
      embeds: [baseEmbed().setDescription(`Your ticket **#${ticket.id}** in **${interaction.guild.name}** was closed. How was your support experience?`)],
      components: [row],
    });
  } catch {
    // user has DMs closed - not a big deal
  }

  setTimeout(() => {
    channel.delete().catch(() => {});
  }, 5000);
}

async function setPriority(interaction, ticketId, priority) {
  db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run(priority, ticketId);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  const p = PRIORITY_LABELS[priority] || PRIORITY_LABELS.normal;
  await interaction.reply({ embeds: [successEmbed(`Priority set to ${p.emoji} ${p.label}.`)] });
  const msg = await interaction.channel.messages.fetch(interaction.message.id).catch(() => null);
  if (msg) await msg.edit({ components: [controlRow(ticket)] }).catch(() => {});
}

function addTag(guildId, channelId, tag) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
  if (!ticket) return null;
  const tags = new Set(JSON.parse(ticket.tags || '[]'));
  tags.add(tag.toLowerCase());
  db.prepare('UPDATE tickets SET tags = ? WHERE id = ?').run(JSON.stringify([...tags]), ticket.id);
  return [...tags];
}

/**
 * Sweeps all open/claimed tickets across guilds and:
 *  - auto-closes ones inactive past the guild's auto_close_hours
 *  - pings staff on ones that have gone past the SLA warning window with no staff reply
 * Intended to be called on an interval from index.js.
 */
async function sweepTickets(client) {
  const openTickets = db.prepare("SELECT * FROM tickets WHERE status != 'closed'").all();
  const now = Date.now();
  for (const ticket of openTickets) {
    const settings = getGuildSettings(ticket.guild_id);
    const guild = client.guilds.cache.get(ticket.guild_id);
    if (!guild) continue;
    const channel = guild.channels.cache.get(ticket.channel_id);
    if (!channel) continue;

    const inactiveMs = now - (ticket.last_activity_at || ticket.opened_at);
    const autoCloseMs = (settings.auto_close_hours || 48) * 60 * 60 * 1000;
    if (inactiveMs > autoCloseMs) {
      channel
        .send({ embeds: [baseEmbed().setDescription(`This ticket has been inactive for over ${settings.auto_close_hours}h and will now be auto-closed.`)] })
        .catch(() => {});
      let transcriptPath = null;
      try {
        transcriptPath = await generateTranscript(channel, ticket);
      } catch {}
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = 'auto', transcript_path = ? WHERE id = ?").run(
        now,
        transcriptPath,
        ticket.id
      );
      if (settings.transcript_channel_id) {
        const logChannel = guild.channels.cache.get(settings.transcript_channel_id);
        if (logChannel) {
          const files = transcriptPath ? [{ attachment: transcriptPath, name: `ticket-${ticket.id}-transcript.html` }] : [];
          logChannel.send({ embeds: [baseEmbed().setDescription(`⏰ Ticket **#${ticket.id}** was auto-closed due to inactivity.`)], files }).catch(() => {});
        }
      }
      setTimeout(() => channel.delete().catch(() => {}), 5000);
      continue;
    }

    const slaMs = (settings.sla_warning_minutes || 30) * 60 * 1000;
    if (!ticket.first_staff_reply_at && now - ticket.opened_at > slaMs && !ticket._sla_pinged) {
      channel
        .send({
          content: settings.support_role_id ? `<@&${settings.support_role_id}>` : undefined,
          embeds: [baseEmbed().setColor(0xfee75c).setDescription(`⚠️ This ticket has had no staff reply for over ${settings.sla_warning_minutes} minutes.`)],
        })
        .catch(() => {});
      // mark in-memory to avoid re-pinging every sweep until a reply/close happens.
      ticket._sla_pinged = true;
    }
  }
}

module.exports = {
  createTicket,
  claimTicket,
  closeTicket,
  setPriority,
  addTag,
  markFirstStaffReply,
  sweepTickets,
  controlRow,
  PRIORITY_LABELS,
};
