const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const config = require('./config');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
  console.log(`[Deploy] Logged in as ${client.user.tag}`);

  // ⚠️ REPLACE THIS WITH YOUR CHANNEL ID WHERE YOU WANT PANELS
  const CHANNEL_ID = '1352636350356000781';

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error('Channel not found! Make sure the ID is correct.');
      process.exit(1);
    }

    // 1. Ticket System Panel
    const ticketEmbed = new EmbedBuilder()
      .setTitle('🎫 Support Tickets')
      .setDescription('Need help or have questions? Click the button below to open a private support ticket with our team.')
      .setColor('#5865F2');

    const ticketButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_claim_new')
        .setLabel('Create Ticket')
        .setEmoji('📩')
        .setStyle(ButtonStyle.Primary)
    );

    // 2. Staff Application Panel
    const appEmbed = new EmbedBuilder()
      .setTitle('📝 Staff Applications')
      .setDescription('Interested in joining our staff team? Click below to fill out an application form.')
      .setColor('#57F287');

    const appButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('app_modal_1')
        .setLabel('Apply Now')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Success)
    );

    console.log('✅ Success! All 2 panels have been posted into your channel.');
  } catch (error) {
    console.error('Failed to post panels:', error);
  } finally {
    client.destroy();
  }
});

client.login(config.token);