const express = require('express');
const path = require('path');
const { REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../src/config');
const { db } = require('../src/database');

// OAuth2 configuration - You need to set these in your .env file
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || config.clientId;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${config.dashboardPort || 3000}/auth/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tickety-plus-secret-key-change-in-production';

const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const app = express();
const PORT = config.dashboardPort || 3000;

app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // true in production with HTTPS
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax'
  }
}));

// Passport configuration
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
  clientID: DISCORD_CLIENT_ID,
  clientSecret: DISCORD_CLIENT_SECRET,
  callbackURL: DISCORD_REDIRECT_URI,
  scope: ['identify', 'guilds']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // Store session in database (with error handling)
    try {
      const now = Date.now();
      db.prepare('INSERT OR REPLACE INTO user_sessions (user_id, access_token, refresh_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
        profile.id,
        accessToken,
        refreshToken,
        now + (24 * 60 * 60 * 1000), // 24 hours
        now
      );
    } catch (dbError) {
      console.error('Database error in OAuth callback:', dbError);
      // Continue anyway - session will be in memory
    }
    
    // Check if user is admin in any guild
    const isAdmin = profile.guilds?.some(guild => guild.permissions & 0x8) || false;
    
    profile.isAdmin = isAdmin;
    return done(null, profile);
  } catch (error) {
    console.error('OAuth strategy error:', error);
    return done(error, null);
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Ensure SQLite table exists with enhanced schema
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_configs (
      custom_id TEXT PRIMARY KEY,
      panel_id TEXT,
      button_label TEXT,
      button_emoji TEXT,
      staff_role_id TEXT,
      category_id TEXT,
      required_role_id TEXT,
      max_tickets_per_user INTEGER DEFAULT 1,
      guild_id TEXT
    )
  `);
  console.log('[Database] panel_configs table ready');
} catch (err) {
  console.error('[Database] Error creating panel_configs table:', err);
}

// Create OAuth2 sessions table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      user_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      created_at INTEGER
    )
  `);
  console.log('[Database] user_sessions table ready');
} catch (err) {
  console.error('[Database] Error creating user_sessions table:', err);
}

// Create guild admins table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_admins (
      guild_id TEXT,
      user_id TEXT,
      added_at INTEGER,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  console.log('[Database] guild_admins table ready');
} catch (err) {
  console.error('[Database] Error creating guild_admins table:', err);
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Auth routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/callback', 
  passport.authenticate('discord', { 
    failureRedirect: '/?error=auth_failed',
    failureMessage: true 
  }),
  (req, res) => {
    console.log('OAuth callback successful, user:', req.user?.username);
    
    // Check if user is admin
    if (!req.user.isAdmin) {
      console.log('User is not admin in any guild');
      res.redirect('/?error=not_admin');
      return;
    }
    
    console.log('Redirecting to dashboard...');
    res.redirect('/');
  }
);

app.get('/auth/user', (req, res) => {
  if (req.isAuthenticated() && req.user.isAdmin) {
    // Filter guilds where user has admin permissions
    const adminGuilds = req.user.guilds?.filter(guild => guild.permissions & 0x8) || [];
    res.json({ authenticated: true, user: req.user, guilds: adminGuilds });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

app.post('/api/send-panel', (req, res, next) => {
  if (!req.isAuthenticated() || !req.user.isAdmin) {
    return res.status(401).json({ success: false, error: 'Authentication required. Only server administrators can access this endpoint.' });
  }
  next();
}, async (req, res) => {
  const { channelId, title, description, color, type, buttons, categoryId, guildId } = req.body;

  try {
    // Fallback empty strings to null to prevent validation crashes
    const embed = new EmbedBuilder()
      .setTitle(title && title.trim() !== '' ? title : null)
      .setDescription(description && description.trim() !== '' ? description : null)
      .setColor(color || '#2b2d31');

    const row = new ActionRowBuilder();
    const panelId = 'panel_' + Math.random().toString(36).substring(2, 9);

    if (type === 'ticket') {
      buttons.forEach((b) => {
        if (b.name && b.name.trim() !== '') {
          // Generate a bulletproof unique custom ID for this specific button instance
          const uniqueId = 'ticket_' + Math.random().toString(36).substring(2, 9);
          
          // Save the mapping with enhanced configuration
          const stmt = db.prepare('INSERT OR REPLACE INTO panel_configs (custom_id, panel_id, button_label, button_emoji, staff_role_id, category_id, required_role_id, max_tickets_per_user, guild_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
          stmt.run(uniqueId, panelId, b.name, b.emoji || null, b.staffRoleId || null, b.categoryId || categoryId || null, b.requiredRoleId || null, b.maxTickets || 1, guildId || null);

          const button = new ButtonBuilder()
            .setCustomId(uniqueId)
            .setLabel(b.name)
            .setStyle(ButtonStyle.Secondary);
          
          if (b.emoji) button.setEmoji(b.emoji);
          row.addComponents(button);
        }
      });
      
      if (row.components.length === 0) {
        return res.status(400).json({ success: false, error: 'You must provide at least one valid button name.' });
      }
    } 
    else if (type === 'application') {
      row.addComponents(new ButtonBuilder().setCustomId('app_modal_1').setLabel('Apply Now').setEmoji('📝').setStyle(ButtonStyle.Success));
    }

    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.post(Routes.channelMessages(channelId), {
      body: { embeds: [embed.toJSON()], components: [row.toJSON()] }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Discord API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`[Dashboard] Pro Panel Builder running at http://localhost:${PORT}`));