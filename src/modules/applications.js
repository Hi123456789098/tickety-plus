const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { db } = require('../database');
const { baseEmbed, successEmbed, errorEmbed } = require('../utils');

function buildModal(panel) {
  const questions = JSON.parse(panel.questions || '[]').slice(0, 5);
  const modal = new ModalBuilder().setCustomId(`app_modal_${panel.id}`).setTitle(`Apply: ${panel.role_label}`.slice(0, 45));
  questions.forEach((q, i) => {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q_${i}`)
          .setLabel(q.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
      )
    );
  });
  return modal;
}

async function startApplication(interaction, panel) {
  const existing = db
    .prepare("SELECT * FROM applications WHERE guild_id = ? AND user_id = ? AND role_key = ? AND status = 'pending'")
    .get(interaction.guild.id, interaction.user.id, panel.role_key);
  if (existing) {
    return interaction.reply({ embeds: [errorEmbed('You already have a pending application for this role.')], ephemeral: true });
  }
  await interaction.showModal(buildModal(panel));
}

async function submitApplication(interaction, panel) {
  const questions = JSON.parse(panel.questions || '[]').slice(0, 5);
  const answers = questions.map((q, i) => ({ question: q, answer: interaction.fields.getTextInputValue(`q_${i}`) }));

  const info = db
    .prepare(
      `INSERT INTO applications (guild_id, user_id, role_key, role_label, answers, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(interaction.guild.id, interaction.user.id, panel.role_key, panel.role_label, JSON.stringify(answers), Date.now());

  const reviewChannel = interaction.guild.channels.cache.get(panel.review_channel_id);
  const embed = baseEmbed()
    .setTitle(`New Application - ${panel.role_label}`)
    .setDescription(`Applicant: ${interaction.user} (${interaction.user.tag})`)
    .addFields(answers.map((a) => ({ name: a.question.slice(0, 256), value: a.answer.slice(0, 1024) || '—' })));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app_approve_${info.lastInsertRowid}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app_deny_${info.lastInsertRowid}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
  );

  if (reviewChannel) {
    const msg = await reviewChannel.send({ embeds: [embed], components: [row] });
    db.prepare('UPDATE applications SET review_message_id = ? WHERE id = ?').run(msg.id, info.lastInsertRowid);
  }

  await interaction.reply({ embeds: [successEmbed('Your application has been submitted! You will be notified by DM once it is reviewed.')], ephemeral: true });
}

async function reviewApplication(interaction, applicationId, approve) {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) return interaction.reply({ embeds: [errorEmbed('Application not found.')], ephemeral: true });
  if (app.status !== 'pending') {
    return interaction.reply({ embeds: [errorEmbed(`Already reviewed (status: ${app.status}).`)], ephemeral: true });
  }

  db.prepare('UPDATE applications SET status = ?, reviewed_by = ? WHERE id = ?').run(
    approve ? 'approved' : 'denied',
    interaction.user.id,
    applicationId
  );

  const panel = db.prepare('SELECT * FROM application_panels WHERE guild_id = ? AND role_key = ?').get(app.guild_id, app.role_key);
  if (approve && panel?.approve_role_id) {
    const member = await interaction.guild.members.fetch(app.user_id).catch(() => null);
    if (member) await member.roles.add(panel.approve_role_id).catch(() => {});
  }

  const originalEmbed = interaction.message.embeds[0];
  const updatedEmbed = baseEmbed()
    .setTitle(originalEmbed.title)
    .setDescription(`${originalEmbed.description}\n\n**Status:** ${approve ? '✅ Approved' : '❌ Denied'} by ${interaction.user}`)
    .addFields(originalEmbed.fields);
  await interaction.update({ embeds: [updatedEmbed], components: [] });

  try {
    const user = await interaction.client.users.fetch(app.user_id);
    await user.send({
      embeds: [
        approve
          ? successEmbed(`Your application for **${app.role_label}** in **${interaction.guild.name}** was approved! 🎉`)
          : errorEmbed(`Your application for **${app.role_label}** in **${interaction.guild.name}** was not approved this time.`),
      ],
    });
  } catch {
    // DMs closed
  }
}

module.exports = { startApplication, submitApplication, reviewApplication };
