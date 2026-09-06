// ============================================================================
// Shift Management Discord Bot — single-file build
// Combines: config, database, utils, commands, buttons, selectMenus, modals,
// events, and slash-command registration into one index.js.
//
// Run: node index.js   (npm start)
// Slash commands are registered automatically on every startup — no separate
// "npm run register" step needed, which keeps deployment on Render simple.
// ============================================================================

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  ActivityType,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { MongoClient } = require('mongodb');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, MONGODB_URI, MONGODB_DB_NAME } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error('Missing CLIENT_ID in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ============================================================================
// CONFIG — constants used across the bot so nothing is "magic"
// ============================================================================

const BOT_PRESENCE = {
  name: 'Developer : LevelingX',
  type: 4, // ActivityType.Custom
};

const DEFAULT_EMBED_COLOR = 0x5865f2; // Discord blurple, used when admin doesn't pick a color

const STATUS = {
  WORKING: 'working',
  OFF: 'off',
  LEAVE: 'leave',
  ABSENT: 'absent',
  NONE: 'none', // has the role but has never interacted / cleared state
};

const LEAVE_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const EMOJI = {
  IN: '🟢',
  OUT: '🔴',
  LEAVE: '📝',
  APPROVE: '✅',
  REJECT: '❌',
  CONFIRM: '✅',
  CANCEL: '❌',
  ABSENT: '🔴',
  UNKNOWN: '⚫',
  ON_LEAVE: '🟡',
  DASHBOARD: '📊',
};

// Custom ID prefixes — every interactive component's customId starts with
// one of these so the interactionCreate handler can route it correctly.
const IDS = {
  SHIFT_IN: 'shift_in',
  SHIFT_OUT: 'shift_out',
  LEAVE_SUBMIT_OPEN: 'leave_submit_open',
  LEAVE_MODAL: 'leave_modal',
  LEAVE_APPROVE: 'leave_approve',
  LEAVE_REJECT: 'leave_reject',
  SETUP_CONFIRM: 'setup_confirm',
  SETUP_CANCEL: 'setup_cancel',
  ABSENCE_SELECT: 'absence_select',
  ABSENCE_CONFIRM: 'absence_confirm',
  ABSENCE_CANCEL: 'absence_cancel',
};

// ============================================================================
// DATABASE — MongoDB via the official `mongodb` driver
//
// Collections:
//   guildSettings  { _id: guildId, allowedRoleId, shiftChannelId, shiftMessageId,
//                    leaveChannelId, leaveMessageId, dashboardChannelId, dashboardMessageId }
//   userStatus     { _id: `${guildId}:${userId}`, guildId, userId, status, shiftStart,
//                    shiftEnd, totalShiftDuration, leaveDate, leaveReason }
//   leaveRequests  { _id: <auto-incrementing number>, guildId, userId, date, reason,
//                    status, createdAt }
//   counters       { _id: name, seq } — backs the auto-incrementing leaveRequests id,
//                    since Mongo has no built-in AUTOINCREMENT like SQLite.
//
// All helpers below are now async (Mongo's driver is promise-based) — every
// call site elsewhere in this file has been updated to `await` them.
// ============================================================================

const mongoClient = new MongoClient(MONGODB_URI);

let guildSettingsCol;
let userStatusCol;
let leaveRequestsCol;
let countersCol;

async function connectDatabase() {
  await mongoClient.connect();
  const db = mongoClient.db(MONGODB_DB_NAME || 'shift_bot');

  guildSettingsCol = db.collection('guildSettings');
  userStatusCol = db.collection('userStatus');
  leaveRequestsCol = db.collection('leaveRequests');
  countersCol = db.collection('counters');

  // Mirrors the SQLite indexes on guildId used for dashboard/status lookups.
  await userStatusCol.createIndex({ guildId: 1 });
  await leaveRequestsCol.createIndex({ guildId: 1 });

  console.log('[database] Connected to MongoDB');
}

// ---- guildSettings helpers ----

async function ensureGuildRow(guildId) {
  await guildSettingsCol.updateOne(
    { _id: guildId },
    { $setOnInsert: { _id: guildId } },
    { upsert: true }
  );
}

async function getSettings(guildId) {
  await ensureGuildRow(guildId);
  const doc = await guildSettingsCol.findOne({ _id: guildId });
  return { guildId: doc._id, ...doc };
}

async function updateSettings(guildId, fields) {
  await ensureGuildRow(guildId);
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  await guildSettingsCol.updateOne({ _id: guildId }, { $set: fields });
}

// ---- userStatus helpers ----

function userStatusId(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function ensureUserRow(guildId, userId) {
  await userStatusCol.updateOne(
    { _id: userStatusId(guildId, userId) },
    { $setOnInsert: { _id: userStatusId(guildId, userId), guildId, userId, status: STATUS.NONE } },
    { upsert: true }
  );
}

async function getStatus(guildId, userId) {
  await ensureUserRow(guildId, userId);
  return userStatusCol.findOne({ _id: userStatusId(guildId, userId) });
}

async function getAllForGuild(guildId) {
  return userStatusCol.find({ guildId }).toArray();
}

async function setShiftStart(guildId, userId, timestamp) {
  await ensureUserRow(guildId, userId);
  await userStatusCol.updateOne(
    { _id: userStatusId(guildId, userId) },
    { $set: { status: STATUS.WORKING, shiftStart: timestamp, shiftEnd: null } }
  );
}

async function setShiftEnd(guildId, userId, timestamp) {
  const row = await getStatus(guildId, userId);
  const duration = row.shiftStart ? Math.max(0, timestamp - row.shiftStart) : 0;
  const newTotal = (row.totalShiftDuration || 0) + duration;
  await userStatusCol.updateOne(
    { _id: userStatusId(guildId, userId) },
    { $set: { status: STATUS.OFF, shiftEnd: timestamp, totalShiftDuration: newTotal } }
  );
  return duration;
}

async function setLeave(guildId, userId, leaveDate, leaveReason) {
  await ensureUserRow(guildId, userId);
  await userStatusCol.updateOne(
    { _id: userStatusId(guildId, userId) },
    { $set: { status: STATUS.LEAVE, leaveDate, leaveReason } }
  );
}

async function setAbsent(guildId, userId) {
  await ensureUserRow(guildId, userId);
  await userStatusCol.updateOne(
    { _id: userStatusId(guildId, userId) },
    { $set: { status: STATUS.ABSENT } }
  );
}

// ---- leaveRequests helpers ----

// Mongo has no native AUTOINCREMENT, so a `counters` doc stands in for
// SQLite's INTEGER PRIMARY KEY AUTOINCREMENT and keeps requestId a plain
// number — that way button customIds (`leave_approve:123`) don't change.
async function getNextRequestId() {
  // NOTE: since mongodb driver v6, findOneAndUpdate() returns the updated
  // document directly (not wrapped in `{ value: doc }` as in v5 and earlier).
  // Using `result.value.seq` throws "Cannot read properties of undefined"
  // on every leave request, which crashes /leave submissions entirely.
  const result = await countersCol.findOneAndUpdate(
    { _id: 'leaveRequests' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.seq;
}

async function createRequest(guildId, userId, date, reason) {
  const requestId = await getNextRequestId();
  await leaveRequestsCol.insertOne({
    _id: requestId,
    guildId,
    userId,
    date,
    reason,
    status: LEAVE_REQUEST_STATUS.PENDING,
    createdAt: Date.now(),
  });
  return requestId;
}

async function getRequest(requestId) {
  const doc = await leaveRequestsCol.findOne({ _id: requestId });
  if (!doc) return null;
  return { requestId: doc._id, ...doc };
}

async function setRequestStatus(requestId, status) {
  await leaveRequestsCol.updateOne({ _id: requestId }, { $set: { status } });
}

// ============================================================================
// UTILS
// ============================================================================

// ---- permissions ----

function isAdmin(member, guild) {
  if (!member || !guild) return false;
  if (guild.ownerId === member.id) return true;
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function hasAllowedRole(member, guild) {
  if (isAdmin(member, guild)) return true;
  const settings = await getSettings(guild.id);
  if (!settings || !settings.allowedRoleId) return false;
  return member.roles.cache.has(settings.allowedRoleId);
}

// ---- pendingSetups (in-memory drafts between /setup-* preview and Confirm/Cancel) ----

const crypto = require('crypto');
const pendingDrafts = new Map();

function createDraft(data) {
  const token = crypto.randomBytes(6).toString('hex');
  pendingDrafts.set(token, data);
  setTimeout(() => pendingDrafts.delete(token), 15 * 60 * 1000).unref();
  return token;
}

function getDraft(token) {
  return pendingDrafts.get(token);
}

function deleteDraft(token) {
  pendingDrafts.delete(token);
}

// ---- embedBuilder ----

function parseColor(colorInput) {
  if (!colorInput) return null;
  const cleaned = colorInput.trim().replace(/^#/, '');
  const parsed = parseInt(cleaned, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildContentEmbed({ title, description, image, footer, color }) {
  const embed = new EmbedBuilder().setColor(parseColor(color) ?? DEFAULT_EMBED_COLOR);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (image) embed.setImage(image);
  if (footer) embed.setFooter({ text: footer });

  // Discord rejects a truly empty embed (no title/description/image/footer),
  // and the admin is allowed to leave every field blank per the spec.
  if (!title && !description && !image && !footer) {
    embed.setDescription('\u200b');
  }

  return embed;
}

function buildPreviewRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.SETUP_CONFIRM}:${token}`)
      .setLabel('Confirm')
      .setEmoji(EMOJI.CONFIRM)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${IDS.SETUP_CANCEL}:${token}`)
      .setLabel('Cancel')
      .setEmoji(EMOJI.CANCEL)
      .setStyle(ButtonStyle.Danger)
  );
}

function buildShiftButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.SHIFT_IN)
      .setLabel('เข้าเวร')
      .setEmoji(EMOJI.IN)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(IDS.SHIFT_OUT)
      .setLabel('ออกเวร')
      .setEmoji(EMOJI.OUT)
      .setStyle(ButtonStyle.Danger)
  );
}

function buildLeaveButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.LEAVE_SUBMIT_OPEN)
      .setLabel('ยื่นใบลา')
      .setEmoji(EMOJI.LEAVE)
      .setStyle(ButtonStyle.Primary)
  );
}

// ---- dashboard ----

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function buildDashboardEmbed(guild, roleMembers, statusRows) {
  const byId = new Map(statusRows.map((r) => [r.userId, r]));

  const working = [];
  const off = [];
  const onLeave = [];
  const absent = [];
  const none = [];

  for (const member of roleMembers.values()) {
    const row = byId.get(member.id);
    const status = row ? row.status : STATUS.NONE;
    switch (status) {
      case STATUS.WORKING:
        working.push(`<@${member.id}> — ${formatTime(row.shiftStart)}`);
        break;
      case STATUS.OFF:
        off.push(`<@${member.id}> — ${formatTime(row.shiftEnd)}`);
        break;
      case STATUS.LEAVE:
        onLeave.push(`<@${member.id}>`);
        break;
      case STATUS.ABSENT:
        absent.push(`<@${member.id}>`);
        break;
      default:
        none.push(`<@${member.id}>`);
    }
  }

  const section = (arr) => (arr.length ? arr.join('\n') : '—');

  return new EmbedBuilder()
    .setColor(DEFAULT_EMBED_COLOR)
    .setTitle(`${EMOJI.DASHBOARD} สถานะการปฏิบัติงาน`)
    .addFields(
      { name: `${EMOJI.IN} กำลังเข้าเวร`, value: section(working) },
      { name: `${EMOJI.OUT} ออกเวรแล้ว`, value: section(off) },
      { name: `${EMOJI.ON_LEAVE} ลางาน`, value: section(onLeave) },
      { name: `${EMOJI.ABSENT} ขาด`, value: section(absent) },
      { name: `${EMOJI.UNKNOWN} ยังไม่ได้เข้าเวร`, value: section(none) }
    )
    .setTimestamp();
}

/**
 * Edits the existing dashboard message in place. Never posts a new message.
 * Safe to call frequently — silently no-ops if the dashboard isn't set up,
 * and self-heals (clears the stored message id) if the message/channel was
 * deleted so /setup-dashboard can be used to recreate it.
 */
async function refreshDashboard(client, guildId) {
  const settings = await getSettings(guildId);
  if (!settings || !settings.dashboardChannelId || !settings.dashboardMessageId) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  if (!settings.allowedRoleId) return; // nothing to show yet

  let channel;
  try {
    channel = await guild.channels.fetch(settings.dashboardChannelId);
  } catch {
    await updateSettings(guildId, { dashboardChannelId: null, dashboardMessageId: null });
    return;
  }
  if (!channel) return;

  let message;
  try {
    message = await channel.messages.fetch(settings.dashboardMessageId);
  } catch {
    await updateSettings(guildId, { dashboardMessageId: null });
    return;
  }

  let role;
  try {
    role = await guild.roles.fetch(settings.allowedRoleId);
  } catch {
    role = null;
  }
  if (!role) return;

  // Make sure member cache is populated for the role's members.
  let roleMembers;
  try {
    await guild.members.fetch();
    roleMembers = role.members;
  } catch {
    roleMembers = role.members; // fall back to whatever is cached
  }

  const statusRows = await getAllForGuild(guildId);
  const embed = buildDashboardEmbed(guild, roleMembers, statusRows);

  try {
    await message.edit({ embeds: [embed] });
  } catch (err) {
    console.error(`[dashboard] failed to edit dashboard message in guild ${guildId}:`, err.message);
  }
}

// ---- setupFlow (shared by /setup-shift and /setup-leave) ----

function addCommonOptions(builder) {
  return builder
    .addStringOption((opt) => opt.setName('title').setDescription('หัวข้อ Embed').setRequired(false))
    .addStringOption((opt) =>
      opt.setName('description').setDescription('รายละเอียด Embed').setRequired(false)
    )
    .addStringOption((opt) => opt.setName('image').setDescription('URL รูปภาพ').setRequired(false))
    .addStringOption((opt) => opt.setName('footer').setDescription('ข้อความ Footer').setRequired(false))
    .addStringOption((opt) =>
      opt.setName('color').setDescription('สีของ Embed เช่น #5865F2').setRequired(false)
    )
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel ที่จะส่ง Embed (ค่าเริ่มต้น: channel นี้)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    );
}

async function handleSetupCommand(interaction, type) {
  if (!isAdmin(interaction.member, interaction.guild)) {
    return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
  }

  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const image = interaction.options.getString('image');
  const footer = interaction.options.getString('footer');
  const color = interaction.options.getString('color');
  const channel = interaction.options.getChannel('channel') || interaction.channel;

  const embedData = { title, description, image, footer, color };
  const embed = buildContentEmbed(embedData);

  const token = createDraft({
    type,
    guildId: interaction.guildId,
    channelId: channel.id,
    embedData,
  });

  return interaction.reply({
    content: `ตัวอย่าง Embed (จะถูกส่งไปที่ ${channel}) — กด Confirm เพื่อยืนยัน หรือ Cancel เพื่อยกเลิก`,
    embeds: [embed],
    components: [buildPreviewRow(token)],
    ephemeral: true,
  });
}

// ============================================================================
// SLASH COMMANDS
// ============================================================================

const commandDefs = [
  {
    data: addCommonOptions(
      new SlashCommandBuilder()
        .setName('setup-main')
        .setDescription('ตั้งค่า Embed สำหรับระบบเข้าเวร/ออกเวร')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ),
    async execute(interaction) {
      return handleSetupCommand(interaction, 'shift');
    },
  },

  {
    data: addCommonOptions(
      new SlashCommandBuilder()
        .setName('setup-leave')
        .setDescription('ตั้งค่า Embed สำหรับระบบยื่นใบลา')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ),
    async execute(interaction) {
      return handleSetupCommand(interaction, 'leave');
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('setup-dashboard')
      .setDescription('สร้าง/ตั้งค่า Dashboard แสดงสถานะการปฏิบัติงาน')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel ที่จะส่ง Dashboard (ค่าเริ่มต้น: channel นี้)')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),
    async execute(interaction) {
      if (!isAdmin(interaction.member, interaction.guild)) {
        return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
      }

      const channel = interaction.options.getChannel('channel') || interaction.channel;

      // Post a placeholder first; refreshDashboard() will immediately fill it in.
      const placeholder = buildDashboardEmbed(interaction.guild, new Map(), []);
      const message = await channel.send({ embeds: [placeholder] });

      await updateSettings(interaction.guildId, {
        dashboardChannelId: channel.id,
        dashboardMessageId: message.id,
      });

      await refreshDashboard(interaction.client, interaction.guildId);

      return interaction.reply({
        content: `ตั้งค่า Dashboard ที่ ${channel} เรียบร้อยแล้ว`,
        ephemeral: true,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('set-role')
      .setDescription('กำหนดยศที่สามารถใช้ระบบเข้าเวร/ออกเวร/ลาได้')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addRoleOption((opt) =>
        opt.setName('role').setDescription('ยศที่ต้องการอนุญาต').setRequired(true)
      ),
    async execute(interaction) {
      if (!isAdmin(interaction.member, interaction.guild)) {
        return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
      }

      const role = interaction.options.getRole('role', true);
      await updateSettings(interaction.guildId, { allowedRoleId: role.id });

      return interaction.reply({
        content: `ตั้งค่ายศสำหรับระบบเป็น ${role} เรียบร้อยแล้ว`,
        ephemeral: true,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('owner-setup')
      .setDescription('ระบุสมาชิกที่ขาดงาน')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
      if (!isAdmin(interaction.member, interaction.guild)) {
        return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
      }

      const settings = await getSettings(interaction.guildId);
      if (!settings.allowedRoleId) {
        return interaction.reply({
          content: 'ยังไม่ได้ตั้งค่ายศระบบ กรุณาใช้ `/set-role` ก่อน',
          ephemeral: true,
        });
      }

      const role = await interaction.guild.roles.fetch(settings.allowedRoleId).catch(() => null);
      if (!role) {
        return interaction.reply({
          content: 'ไม่พบยศที่ตั้งค่าไว้ (อาจถูกลบไปแล้ว) กรุณาตั้งค่าใหม่ด้วย `/set-role`',
          ephemeral: true,
        });
      }

      await interaction.guild.members.fetch().catch(() => null);

      const statusByUser = new Map(
        (await getAllForGuild(interaction.guildId)).map((r) => [r.userId, r.status])
      );

      const eligible = role.members.filter((member) => {
        const status = statusByUser.get(member.id) || STATUS.NONE;
        return status !== STATUS.WORKING && status !== STATUS.LEAVE;
      });

      if (eligible.size === 0) {
        return interaction.reply({
          content: 'ไม่มีสมาชิกที่ต้องระบุว่าขาดงาน (ทุกคนเข้าเวรหรือลาแล้ว)',
          ephemeral: true,
        });
      }

      const options = [...eligible.values()].slice(0, 25).map((member) => ({
        label: member.displayName.slice(0, 100),
        value: member.id,
      }));

      const select = new StringSelectMenuBuilder()
        .setCustomId(IDS.ABSENCE_SELECT)
        .setPlaceholder('เลือกสมาชิกที่ขาดงาน')
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options);

      return interaction.reply({
        content: 'เลือกสมาชิกที่ขาดงาน',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    },
  },
];

// ============================================================================
// BUTTON HANDLERS
// ============================================================================

const buttonHandlers = new Map();

buttonHandlers.set(IDS.SHIFT_IN, {
  async execute(interaction) {
    if (!(await hasAllowedRole(interaction.member, interaction.guild))) {
      return interaction.reply({ content: 'คุณไม่มีสิทธิ์ใช้งานระบบนี้', ephemeral: true });
    }

    const current = await getStatus(interaction.guildId, interaction.user.id);

    if (current.status === STATUS.WORKING) {
      return interaction.reply({ content: 'คุณกำลังเข้าเวรอยู่แล้ว', ephemeral: true });
    }
    if (current.status === STATUS.LEAVE) {
      return interaction.reply({
        content: 'คุณอยู่ในสถานะลา ไม่สามารถเข้าเวรได้จนกว่าจะจัดการสถานะลาก่อน',
        ephemeral: true,
      });
    }

    await setShiftStart(interaction.guildId, interaction.user.id, Date.now());
    await refreshDashboard(interaction.client, interaction.guildId);

    return interaction.reply({ content: 'บันทึกเข้าเวรเรียบร้อยแล้ว', ephemeral: true });
  },
});

buttonHandlers.set(IDS.SHIFT_OUT, {
  async execute(interaction) {
    if (!(await hasAllowedRole(interaction.member, interaction.guild))) {
      return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานระบบนี้', ephemeral: true });
    }

    const current = await getStatus(interaction.guildId, interaction.user.id);

    if (current.status !== STATUS.WORKING) {
      return interaction.reply({ content: 'คุณยังไม่ได้เข้าเวร', ephemeral: true });
    }

    await setShiftEnd(interaction.guildId, interaction.user.id, Date.now());
    await refreshDashboard(interaction.client, interaction.guildId);

    return interaction.reply({ content: 'บันทึกออกเวรเรียบร้อยแล้ว', ephemeral: true });
  },
});

buttonHandlers.set(IDS.LEAVE_SUBMIT_OPEN, {
  async execute(interaction) {
    if (!(await hasAllowedRole(interaction.member, interaction.guild))) {
      return interaction.reply({ content: 'คุณไม่มีสิทธิ์ใช้งานระบบนี้', ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(IDS.LEAVE_MODAL).setTitle('ยื่นใบลา');

    const dateInput = new TextInputBuilder()
      .setCustomId('leave_date')
      .setLabel('วันที่ลา')
      .setPlaceholder('เช่น 15/09/2026 หรือ 15-17/09/2026')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('leave_reason')
      .setLabel('เหตุผลการลา')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(dateInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );

    return interaction.showModal(modal);
  },
});

buttonHandlers.set(IDS.LEAVE_APPROVE, {
  async execute(interaction, requestId) {
    if (!isAdmin(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
    }

    const request = await getRequest(Number(requestId));
    if (!request) {
      return interaction.reply({ content: 'ไม่พบคำขอลานี้แล้ว', ephemeral: true });
    }
    if (request.status !== LEAVE_REQUEST_STATUS.PENDING) {
      return interaction.reply({ content: 'คำขอนี้ถูกดำเนินการไปแล้ว', ephemeral: true });
    }

    await setRequestStatus(request.requestId, LEAVE_REQUEST_STATUS.APPROVED);
    await setLeave(request.guildId, request.userId, request.date, request.reason);
    await refreshDashboard(interaction.client, request.guildId);

    const oldEmbed = interaction.message.embeds[0];
    const updatedEmbed = { ...oldEmbed.data };
    updatedEmbed.fields = updatedEmbed.fields.map((f) =>
      f.name === 'สถานะ' ? { ...f, value: 'อนุมัติ' } : f
    );

    const disabledRow = new ActionRowBuilder().addComponents(
      ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
      ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
    );

    await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

    // Best-effort DM notification; falls back silently if DMs are closed.
    try {
      const user = await interaction.client.users.fetch(request.userId);
      await user.send(
        `${EMOJI.APPROVE} คำขอลาของคุณสำหรับวันที่ ${request.date} ได้รับการอนุมัติแล้ว`
      );
    } catch {
      // DM failed (user has DMs off, left server, etc.) — safe to ignore.
    }
  },
});

buttonHandlers.set(IDS.LEAVE_REJECT, {
  async execute(interaction, requestId) {
    if (!isAdmin(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
    }

    const request = await getRequest(Number(requestId));
    if (!request) {
      return interaction.reply({ content: 'ไม่พบคำขอลานี้แล้ว', ephemeral: true });
    }
    if (request.status !== LEAVE_REQUEST_STATUS.PENDING) {
      return interaction.reply({ content: 'คำขอนี้ถูกดำเนินการไปแล้ว', ephemeral: true });
    }

    await setRequestStatus(request.requestId, LEAVE_REQUEST_STATUS.REJECTED);
    // Intentionally NOT touching user_status — a rejected request must not show as "leave".

    const oldEmbed = interaction.message.embeds[0];
    const updatedEmbed = { ...oldEmbed.data };
    updatedEmbed.fields = updatedEmbed.fields.map((f) =>
      f.name === 'สถานะ' ? { ...f, value: 'ไม่อนุมัติ' } : f
    );

    const disabledRow = new ActionRowBuilder().addComponents(
      ButtonBuilder.from(interaction.message.components[0].components[0]).setDisabled(true),
      ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true)
    );

    await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });

    try {
      const user = await interaction.client.users.fetch(request.userId);
      await user.send(`${EMOJI.REJECT} คำขอลาของคุณสำหรับวันที่ ${request.date} ไม่ได้รับการอนุมัติ`);
    } catch {
      // DM failed — safe to ignore.
    }
  },
});

buttonHandlers.set(IDS.SETUP_CONFIRM, {
  async execute(interaction, token) {
    if (!isAdmin(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
    }

    const draft = getDraft(token);
    if (!draft) {
      return interaction.update({
        content: 'Preview นี้หมดอายุแล้ว กรุณาใช้คำสั่งอีกครั้ง',
        embeds: [],
        components: [],
      });
    }

    const channel = await interaction.guild.channels.fetch(draft.channelId).catch(() => null);
    if (!channel) {
      deleteDraft(token);
      return interaction.update({
        content: 'ไม่พบ Channel ที่เลือกไว้ กรุณาใช้คำสั่งอีกครั้ง',
        embeds: [],
        components: [],
      });
    }

    const embed = buildContentEmbed(draft.embedData);
    const row = draft.type === 'shift' ? buildShiftButtonsRow() : buildLeaveButtonRow();

    const message = await channel.send({ embeds: [embed], components: [row] });

    if (draft.type === 'shift') {
      await updateSettings(draft.guildId, { shiftChannelId: channel.id, shiftMessageId: message.id });
    } else {
      await updateSettings(draft.guildId, { leaveChannelId: channel.id, leaveMessageId: message.id });
    }

    deleteDraft(token);

    return interaction.update({
      content: `สร้าง Embed เรียบร้อยแล้วที่ ${channel}`,
      embeds: [],
      components: [],
    });
  },
});

buttonHandlers.set(IDS.SETUP_CANCEL, {
  async execute(interaction, token) {
    deleteDraft(token);
    return interaction.update({ content: 'ยกเลิกแล้ว', embeds: [], components: [] });
  },
});

buttonHandlers.set(IDS.ABSENCE_CONFIRM, {
  async execute(interaction, token) {
    if (!isAdmin(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
    }

    const draft = getDraft(token);
    if (!draft) {
      return interaction.update({ content: 'รายการนี้หมดอายุแล้ว กรุณาใช้คำสั่งอีกครั้ง', components: [] });
    }

    for (const userId of draft.userIds) {
      await setAbsent(draft.guildId, userId);
    }
    await refreshDashboard(interaction.client, draft.guildId);
    deleteDraft(token);

    const mentions = draft.userIds.map((id) => `<@${id}>`).join('\n');
    return interaction.update({ content: `บันทึกสถานะขาดงานแล้ว:\n${mentions}`, components: [] });
  },
});

buttonHandlers.set(IDS.ABSENCE_CANCEL, {
  async execute(interaction, token) {
    deleteDraft(token);
    return interaction.update({ content: 'ยกเลิกแล้ว', components: [] });
  },
});

// ============================================================================
// SELECT MENU HANDLERS
// ============================================================================

const selectMenuHandlers = new Map();

selectMenuHandlers.set(IDS.ABSENCE_SELECT, {
  async execute(interaction) {
    if (!isAdmin(interaction.member, interaction.guild)) {
      return interaction.reply({ content: 'แกไม่มีสิทธิ์ใช้งานคำสั่งนี้', ephemeral: true });
    }

    const userIds = interaction.values;
    const token = createDraft({ guildId: interaction.guildId, userIds });

    const mentions = userIds.map((id) => `<@${id}>`).join('\n');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.ABSENCE_CONFIRM}:${token}`)
        .setLabel('Confirm')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.ABSENCE_CANCEL}:${token}`)
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Danger)
    );

    return interaction.update({
      content: `ยืนยันระบุสมาชิกต่อไปนี้ว่าขาดงาน\n${mentions}`,
      components: [row],
    });
  },
});

// ============================================================================
// MODAL HANDLERS
// ============================================================================

const modalHandlers = new Map();

modalHandlers.set(IDS.LEAVE_MODAL, {
  async execute(interaction) {
    const date = interaction.fields.getTextInputValue('leave_date');
    const reason = interaction.fields.getTextInputValue('leave_reason');

    const settings = await getSettings(interaction.guildId);
    if (!settings.leaveChannelId) {
      return interaction.reply({
        content: 'ระบบลายังไม่ถูกตั้งค่า แจ้งหัวดิสให้ใช้ `/setup-leave` ก่อน',
        ephemeral: true,
      });
    }

    const channel = await interaction.guild.channels.fetch(settings.leaveChannelId).catch(() => null);
    if (!channel) {
      return interaction.reply({
        content: 'ไม่พบ Channel สำหรับคำขอลา ให้หัวดิสตั้งค่าใหม่',
        ephemeral: true,
      });
    }

    const requestId = await createRequest(interaction.guildId, interaction.user.id, date, reason);

    const embed = new EmbedBuilder()
      .setColor(DEFAULT_EMBED_COLOR)
      .setTitle('คำขอลา')
      .addFields(
        { name: 'ผู้ขอลา', value: `<@${interaction.user.id}>` },
        { name: 'วันที่ลา', value: date },
        { name: 'เหตุผล', value: reason },
        { name: 'สถานะ', value: 'รออนุมัติ' }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.LEAVE_APPROVE}:${requestId}`)
        .setLabel('Approve')
        .setEmoji(EMOJI.APPROVE)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.LEAVE_REJECT}:${requestId}`)
        .setLabel('Reject')
        .setEmoji(EMOJI.REJECT)
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });

    return interaction.reply({ content: 'ส่งคำขอลาเรียบร้อยแล้ว รอการอนุมัติ', ephemeral: true });
  },
});

// ============================================================================
// CLIENT SETUP
// ============================================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.commands = new Collection();
for (const command of commandDefs) {
  client.commands.set(command.data.name, command);
}

// ---- events/interactionCreate ----

async function safeErrorReply(interaction, error) {
  console.error('[interactionCreate] error handling interaction:', error);
  const payload = { content: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง', ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    // Interaction likely already expired/acknowledged — nothing more we can do.
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      return await command.execute(interaction);
    }

    if (interaction.isButton()) {
      const [prefix, ...rest] = interaction.customId.split(':');
      const handler = buttonHandlers.get(prefix);
      if (!handler) return;
      return await handler.execute(interaction, ...rest);
    }

    if (interaction.isStringSelectMenu()) {
      const [prefix, ...rest] = interaction.customId.split(':');
      const handler = selectMenuHandlers.get(prefix);
      if (!handler) return;
      return await handler.execute(interaction, ...rest);
    }

    if (interaction.isModalSubmit()) {
      const [prefix, ...rest] = interaction.customId.split(':');
      const handler = modalHandlers.get(prefix);
      if (!handler) return;
      return await handler.execute(interaction, ...rest);
    }
  } catch (error) {
    await safeErrorReply(interaction, error);
  }
});

// ---- events/ready ----

client.once('ready', async () => {
  console.log(`[ready] Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: BOT_PRESENCE.name, type: ActivityType.Custom, state: BOT_PRESENCE.name }],
    status: 'online',
  });

  // On restart: settings/status already live in MongoDB (nothing to "load"
  // into memory), so all that's needed is to resync every guild's existing
  // dashboard message in case anything changed while the bot was offline.
  for (const guild of client.guilds.cache.values()) {
    try {
      await refreshDashboard(client, guild.id);
    } catch (err) {
      console.error(`[ready] failed to refresh dashboard for guild ${guild.id}:`, err.message);
    }
  }
});

// Catch anything that slips past per-interaction error handling so the
// process itself never crashes the bot.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// ============================================================================
// SLASH COMMAND REGISTRATION — runs automatically on every startup so a
// separate "npm run register" step isn't needed (handy on Render's free tier,
// where you only get a single "npm start").
// If GUILD_ID is set, commands register instantly to that one server (best
// while developing). Leave it blank to register globally (can take up to
// ~1 hour to appear everywhere, but works in every server the bot joins).
// ============================================================================

async function registerCommands() {
  const body = commandDefs.map((c) => c.data.toJSON());
  const rest = new REST().setToken(DISCORD_TOKEN);

  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  try {
    const data = await rest.put(route, { body });
    console.log(
      `✅ Registered ${data.length} slash command(s) ${GUILD_ID ? `to guild ${GUILD_ID}` : 'globally'}.`
    );
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error);
  }
}

// ============================================================================
// START
// ============================================================================

(async () => {
  await connectDatabase();
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
