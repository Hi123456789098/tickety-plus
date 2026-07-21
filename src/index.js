const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, REST, Routes, SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const config = require('./config');
const { db } = require('./database');
const { markFirstStaffReply } = require('./modules/tickets');
const { submitApplication, reviewApplication } = require('./modules/applications');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const activeGiveaways = new Map();

client.on('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}. Ready.`);
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log('[Bot] Slash commands synced.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  // ==========================================
  // 1. MODAL SUBMIT (Applications & Close Ticket)
  // ==========================================
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('app_modal_')) {
      const panelId = interaction.customId.replace('app_modal_', '');
      const panel = db.prepare('SELECT * FROM application_panels WHERE id = ?').get(panelId);
      if (panel) {
        await submitApplication(interaction, panel);
      }
    }
    
    if (interaction.customId === 'close_ticket_modal') {
      const reason = interaction.fields.getTextInputValue('close_reason') || 'No reason provided';
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channel.id);
      
      if (!ticket) {
        return interaction.reply({ content: 'Ticket not found.', ephemeral: true });
      }

      await interaction.reply('🔒 Closing ticket and generating transcript...');

      // Generate transcript
      const { generateTranscript } = require('./modules/tickets');
      let transcriptPath = null;
      try {
        transcriptPath = await generateTranscript(interaction.channel, ticket);
      } catch (err) {
        console.error('Transcript generation failed:', err);
      }

      // Update database
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, transcript_path = ? WHERE channel_id = ?").run(
        Date.now(),
        interaction.user.id,
        transcriptPath,
        interaction.channel.id
      );

      // Send to transcript channel if configured
      const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(interaction.guild.id);
      if (settings?.transcript_channel_id) {
        const logChannel = interaction.guild.channels.cache.get(settings.transcript_channel_id);
        if (logChannel) {
          const files = transcriptPath ? [{ attachment: transcriptPath, name: `ticket-${ticket.id}-transcript.html` }] : [];
          await logChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`Transcript - Ticket #${ticket.id}`)
                .addFields(
                  { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
                  { name: 'Closed by', value: `${interaction.user}`, inline: true },
                  { name: 'Reason', value: reason }
                )
            ],
            files
          }).catch(() => {});
        }
      }

      // Delete channel after delay
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
  }

  // ==========================================
  // 2. BUTTON INTERACTIONS
  // ==========================================
  if (interaction.isButton()) {
    
    // DYNAMIC TICKET CREATION (Looks up staff role and category from SQLite DB)
    if (interaction.customId.startsWith('ticket_')) {
      // Look up full button configuration from the dashboard
      const configRow = db.prepare('SELECT * FROM panel_configs WHERE custom_id = ?').get(interaction.customId);
      
      if (!configRow) {
        return interaction.reply({ content: '❌ Configuration error: This ticket button is not configured.', ephemeral: true });
      }

      const { staff_role_id, category_id, required_role_id, max_tickets_per_user } = configRow;

      // Check if user has required role (if specified)
      if (required_role_id && !interaction.member.roles.cache.has(required_role_id)) {
        return interaction.reply({ content: '❌ You do not have the required role to create this ticket.', ephemeral: true });
      }

      // Check ticket limit for this user
      const userTicketCount = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'").get(interaction.guild.id, interaction.user.id);
      if (userTicketCount.count >= (max_tickets_per_user || 1)) {
        return interaction.reply({ content: `❌ You have reached your ticket limit (${max_tickets_per_user || 1}). Close existing tickets first.`, ephemeral: true });
      }

      const channelName = `ticket-${interaction.user.username}`;
      
      // Check if the user already has an open ticket *inside this specific category*
      const existingChannel = interaction.guild.channels.cache.find(c => 
        c.parentId === category_id && c.name.toLowerCase() === channelName.toLowerCase()
      );

      if (existingChannel) {
        return interaction.reply({ content: `You already have an open ticket in this category: <#${existingChannel.id}>`, ephemeral: true });
      }

      await interaction.reply({ content: 'Opening your ticket...', ephemeral: true });

      try {
        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category_id || undefined,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
            { id: interaction.guild.members.me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] }
          ]
        });

        // Add staff role to permissions if specified
        if (staff_role_id) {
          await ticketChannel.permissionOverwrites.create(staff_role_id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          });
        }
        
        await interaction.editReply(`✅ Ticket created: <#${ticketChannel.id}>`);

        const welcomeEmbed = new EmbedBuilder()
          .setTitle('Support Ticket')
          .setDescription(`Hello <@${interaction.user.id}>!\n\nPlease describe your issue. Support will be with you shortly.`)
          .setColor('#2b2d31');

        const controls = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`claim_${staff_role_id}`).setLabel('Claim Ticket').setEmoji('🙋‍♂️').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );

        // Ping the user and staff role in the content parameter so they get a notification ping
        await ticketChannel.send({ 
          content: staff_role_id ? `<@${interaction.user.id}> <@&${staff_role_id}>` : `<@${interaction.user.id}>`, 
          embeds: [welcomeEmbed], 
          components: [controls] 
        });
      } catch (err) {
        console.error(err);
        await interaction.editReply('❌ Failed to create ticket. Ensure I have the "Manage Channels" permission and the Category/Role IDs are correct.');
      }
    }

    // CLAIM TICKET
    if (interaction.customId.startsWith('claim_')) {
      const staffRoleId = interaction.customId.replace('claim_', '');

      if (!interaction.member.roles.cache.has(staffRoleId) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You do not have permission to claim tickets!', ephemeral: true });
      }

      // Check if ticket is already claimed
      const existingClaim = db.prepare('SELECT claimed_by FROM tickets WHERE channel_id = ?').get(interaction.channel.id);
      if (existingClaim && existingClaim.claimed_by) {
        return interaction.reply({ content: `This ticket is already claimed by <@${existingClaim.claimed_by}>.`, ephemeral: true });
      }

      // Update database
      db.prepare("UPDATE tickets SET claimed_by = ?, claimed_at = ?, status = 'claimed' WHERE channel_id = ?").run(
        interaction.user.id,
        Date.now(),
        interaction.channel.id
      );

      const claimEmbed = new EmbedBuilder()
        .setDescription(`✅ This ticket is now handled by <@${interaction.user.id}>.`)
        .setColor('#57F287')
        .addFields({ name: 'Claimed At', value: new Date().toLocaleString(), inline: true });

      const updatedControls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('claim_disabled').setLabel(`Claimed by ${interaction.user.username}`).setEmoji('✅').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('unclaim_ticket').setLabel('Unclaim').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
      );

      await interaction.message.edit({ components: [updatedControls] });
      await interaction.reply({ embeds: [claimEmbed] });
    }

    // UNCLAIM TICKET
    if (interaction.customId === 'unclaim_ticket') {
      const ticket = db.prepare('SELECT claimed_by FROM tickets WHERE channel_id = ?').get(interaction.channel.id);
      
      if (!ticket || !ticket.claimed_by) {
        return interaction.reply({ content: 'This ticket is not claimed.', ephemeral: true });
      }

      if (ticket.claimed_by !== interaction.user.id && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You can only unclaim your own tickets or be an admin.', ephemeral: true });
      }

      db.prepare("UPDATE tickets SET claimed_by = NULL, claimed_at = NULL, status = 'open' WHERE channel_id = ?").run(interaction.channel.id);

      const unclaimEmbed = new EmbedBuilder()
        .setDescription(`🔄 Ticket unclaimed by <@${interaction.user.id}>.`)
        .setColor('#fee75c');

      const updatedControls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`claim_${interaction.guild.roles.cache.find(r => r.name.includes('Support') || r.name.includes('Staff'))?.id || 'staff'}`).setLabel('Claim Ticket').setEmoji('🙋‍♂️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
      );

      await interaction.message.edit({ components: [updatedControls] });
      await interaction.reply({ embeds: [unclaimEmbed] });
    }

    // APPLICATION APPROVE/DENY
    if (interaction.customId.startsWith('app_approve_')) {
      const appId = interaction.customId.replace('app_approve_', '');
      await reviewApplication(interaction, appId, true);
    }
    if (interaction.customId.startsWith('app_deny_')) {
      const appId = interaction.customId.replace('app_deny_', '');
      await reviewApplication(interaction, appId, false);
    }

    // CLOSE TICKET
    if (interaction.customId === 'close_ticket') {
      const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channel.id);
      
      if (!ticket) {
        return interaction.reply({ content: 'Ticket not found in database.', ephemeral: true });
      }

      // Only allow ticket creator, claimer, or admins to close
      if (ticket.user_id !== interaction.user.id && ticket.claimed_by !== interaction.user.id && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'You do not have permission to close this ticket.', ephemeral: true });
      }

      // Ask for close reason
      const closeModal = new ModalBuilder()
        .setCustomId('close_ticket_modal')
        .setTitle('Close Ticket')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('close_reason')
              .setLabel('Reason for closing (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(500)
          )
        );

      await interaction.showModal(closeModal);
    }
  }
});

// ==========================================
// MESSAGE CREATE HANDLER
// ==========================================
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const settings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(message.guild.id);
  if (settings) {
    await markFirstStaffReply(message, settings);
  }
}); 

client.login(config.token);