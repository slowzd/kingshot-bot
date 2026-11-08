import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
  type Role,
} from "discord.js";
import { CopilotClient } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  parseRequestPlan,
  requestPlanSchema,
  requestPlannerSystemMessage,
  type RequestAction,
  type RequestPlan,
} from "./request.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the environment or .env file.`);
  return value;
}

function snowflake(name: string): string {
  const value = env(name);
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${name} must be a Discord ID.`);
  return value;
}

const token = env("DISCORD_TOKEN");
const clientId = snowflake("DISCORD_CLIENT_ID");
const guildId = snowflake("DISCORD_GUILD_ID");

const commands = [
  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Manage member roles")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("assign")
        .setDescription("Assign a role to a member")
        .addUserOption((option) => option.setName("member").setDescription("Member to update").setRequired(true))
        .addRoleOption((option) => option.setName("role").setDescription("Role to assign").setRequired(true)),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a role from a member")
        .addUserOption((option) => option.setName("member").setDescription("Member to update").setRequired(true))
        .addRoleOption((option) => option.setName("role").setDescription("Role to remove").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Manage server channels")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rename")
        .setDescription("Rename a channel")
        .addChannelOption((option) => option.setName("channel").setDescription("Channel to rename").setRequired(true))
        .addStringOption((option) =>
          option.setName("name").setDescription("New channel name").setMinLength(1).setMaxLength(100).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("move")
        .setDescription("Reorder a channel (position starts at 0)")
        .addChannelOption((option) => option.setName("channel").setDescription("Channel to move").setRequired(true))
        .addIntegerOption((option) =>
          option.setName("position").setDescription("New position, starting at 0").setMinValue(0).setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a text, voice, or category channel")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("New channel name")
            .setMinLength(1)
            .setMaxLength(100)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Channel type")
            .setRequired(true)
            .addChoices(
              { name: "Text", value: "text" },
              { name: "Voice", value: "voice" },
              { name: "Category", value: "category" },
            ),
        )
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("Optional parent category (not used when creating a category)")
            .addChannelTypes(ChannelType.GuildCategory),
        ),
    ),
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Describe a server task for the bot to plan")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("description")
        .setDescription("What should the bot do?")
        .setMinLength(1)
        .setMaxLength(4000)
        .setRequired(true),
    ),
].map((command) => command.toJSON());

class UserFacingError extends Error {}

interface PendingRequest {
  guildId: string;
  requesterId: string;
  actions: RequestAction[];
  mentionedMemberIds: string[];
  expiresAt: number;
}

interface PlannedChannelRef {
  type: ChannelType;
  id: string | null;
}

const pendingRequests = new Map<string, PendingRequest>();
const requestLifetimeMs = 5 * 60 * 1000;
const copilotClient = new CopilotClient({
  mode: "copilot-cli",
  baseDirectory: process.env.COPILOT_HOME?.trim() || path.join(homedir(), ".copilot"),
  logLevel: "error",
});
let copilotStarted = false;
let copilotStart: Promise<void> | null = null;

async function ensureCopilotStarted(): Promise<void> {
  if (!copilotStart) {
    copilotStart = copilotClient.start().then(
      () => { copilotStarted = true; },
      (error: unknown) => {
        copilotStart = null;
        throw error;
      },
    );
  }
  await copilotStart;
}

async function requirePermission(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  permission: bigint,
  label: string,
): Promise<void> {
  if (!interaction.memberPermissions?.has(permission)) {
    throw new UserFacingError(`You need the **${label}** permission to use this command.`);
  }

  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!botMember.permissions.has(permission)) {
    throw new UserFacingError(`The bot needs the **${label}** permission in this server.`);
  }
}

async function checkRoleHierarchy(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  role: Role,
): Promise<void> {
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!role.editable) {
    throw new UserFacingError("The bot cannot manage that role. Move the bot's highest role above it.");
  }

  const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  if (!isAdministrator) {
    const actor = await guild.members.fetch(interaction.user.id);
    if (actor.roles.highest.comparePositionTo(role) <= 0) {
      throw new UserFacingError("You can only manage roles below your highest role.");
    }
  }

  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new UserFacingError("Move the bot's highest role above the role you want it to manage.");
  }
}

function escapeDiscordText(value: string): string {
  return value.replace(/@/g, "@\u200B").replace(/[`*_~|]/g, "'");
}

function actionSummary(action: RequestAction): string {
  switch (action.kind) {
    case "channel_create":
      return `Create ${action.channelType} channel/category **${escapeDiscordText(action.name)}**`
        + (action.category ? ` under **${escapeDiscordText(action.category)}**` : "")
        + (action.position === null ? "" : ` at position ${action.position}`);
    case "channel_rename":
      return `Rename **${escapeDiscordText(action.channel)}** to **${escapeDiscordText(action.name)}**`;
    case "channel_move":
      return `Move **${escapeDiscordText(action.channel)}** to position ${action.position}`;
    case "role_assign":
    case "role_remove":
      return `${action.kind === "role_assign" ? "Assign" : "Remove"} role **${escapeDiscordText(action.role)}**`
        + ` for member ID \`${action.memberId}\``;
    case "message_send":
      return `Post this message in **${escapeDiscordText(action.channel)}**:\n> ${escapeDiscordText(action.content).replace(/\n/g, "\n> ")}`;
  }
}

function getMentionedMemberIds(description: string): Set<string> {
  return new Set([...description.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]));
}

async function createRequestPlan(description: string, snapshot: object): Promise<RequestPlan> {
  await ensureCopilotStarted();
  const auth = await copilotClient.getAuthStatus();
  if (!auth.isAuthenticated) {
    throw new UserFacingError(
      "The bot is not signed in to GitHub Copilot. On the bot host, install the Copilot CLI "
      + "(npm install -g @github/copilot), run copilot and use /login as the same OS user "
      + "that runs the bot, then restart the bot. Alternatively, configure COPILOT_GITHUB_TOKEN "
      + "with a fine-grained token that has Copilot Requests permission. No changes were made.",
    );
  }

  const model = process.env.COPILOT_MODEL?.trim();
  const session = await copilotClient.createSession({
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    enableSessionTelemetry: false,
    skipCustomInstructions: true,
    mcpOAuthTokenStorage: "in-memory",
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    memory: { enabled: false },
    customAgentsLocalOnly: true,
    customAgents: [],
    includedBuiltinSkills: [],
    coauthorEnabled: false,
    manageScheduleEnabled: false,
    enableExperimentalMode: false,
    systemMessage: { mode: "replace", content: requestPlannerSystemMessage },
    ...(model ? { model } : {}),
  });

  try {
    const response = await session.sendAndWait({
      prompt: JSON.stringify({
        request: description,
        server_snapshot: snapshot,
        explicitly_mentioned_member_ids: [...getMentionedMemberIds(description)],
      }),
      responseSchema: requestPlanSchema,
    }, 60_000);
    if (!response?.data.content) throw new UserFacingError("Copilot did not return a usable plan.");
    return parseRequestPlan(response.data.content);
  } finally {
    try {
      await session.disconnect();
    } finally {
      await copilotClient.deleteSession(session.sessionId);
    }
  }
}

function resolveChannel(
  reference: string,
  channels: Iterable<GuildBasedChannel>,
  expectedTypes?: ChannelType[],
): GuildBasedChannel {
  const normalized = reference.trim().toLocaleLowerCase();
  const id = reference.match(/^<#?(\d{17,20})>$/)?.[1] ?? reference;
  const all = [...channels];
  const byId = all.find((channel) => channel.id === id);
  const matches = byId
    ? [byId]
    : all.filter((channel) => channel.name.toLocaleLowerCase() === normalized);
  if (matches.length === 0) throw new UserFacingError(`I couldn't find the channel or category **${escapeDiscordText(reference)}**.`);
  if (matches.length > 1) throw new UserFacingError(`More than one channel is named **${escapeDiscordText(reference)}**. Use its mention or ID.`);
  const channel = matches[0];
  if (!channel || channel.isThread() || (expectedTypes && !expectedTypes.includes(channel.type))) {
    throw new UserFacingError(`**${escapeDiscordText(reference)}** isn't a suitable channel for that action.`);
  }
  return channel;
}

function resolveRole(reference: string, roles: Iterable<Role>): Role {
  const normalized = reference.trim().toLocaleLowerCase();
  const all = [...roles];
  const byId = all.find((role) => role.id === reference);
  const matches = byId ? [byId] : all.filter((role) => role.name.toLocaleLowerCase() === normalized);
  if (matches.length === 0) throw new UserFacingError(`I couldn't find the role **${escapeDiscordText(reference)}**.`);
  if (matches.length > 1) throw new UserFacingError(`More than one role is named **${escapeDiscordText(reference)}**. Use its ID.`);
  const role = matches[0];
  if (!role) throw new UserFacingError("That role no longer exists.");
  return role;
}

function channelTypeName(channel: GuildBasedChannel): string {
  if (channel.type === ChannelType.GuildCategory) return "category";
  if (channel.type === ChannelType.GuildText) return "text";
  if (channel.type === ChannelType.GuildVoice) return "voice";
  return `other:${channel.type}`;
}

async function fetchGuildChannels(guild: Guild): Promise<NonThreadGuildBasedChannel[]> {
  const channels = await guild.channels.fetch();
  return [...channels.values()].filter((channel): channel is NonThreadGuildBasedChannel => channel !== null);
}

async function loadServerSnapshot(guild: Guild): Promise<{
  server: { id: string; name: string };
  channels: Array<{ id: string; name: string; type: string; parentId: string | null }>;
  roles: Array<{ id: string; name: string }>;
}> {
  const channels = await fetchGuildChannels(guild);
  const roles = await guild.roles.fetch();
  return {
    server: { id: guild.id, name: guild.name },
    channels: channels
      .filter((channel) => !channel.isThread())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channelTypeName(channel),
        parentId: channel.parentId,
      })),
    roles: [...roles.values()]
      .filter((role) => !role.managed && role.id !== guild.id)
      .map(({ id, name }) => ({ id, name })),
  };
}

async function validateRequestPlan(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  actions: RequestAction[],
  mentionedMemberIds: Set<string>,
): Promise<void> {
  const channels = await fetchGuildChannels(guild);
  const roles = await guild.roles.fetch();
  const plannedChannels = new Map<string, PlannedChannelRef>();

  for (const action of actions) {
    if (action.kind.startsWith("channel_")) {
      await requirePermission(interaction, guild, PermissionFlagsBits.ManageChannels, "Manage Channels");
    }

    switch (action.kind) {
      case "channel_create": {
        if (channels.some((channel) => !channel.isThread() && channel.name.toLocaleLowerCase() === action.name.toLocaleLowerCase())
          || plannedChannels.has(action.name.toLocaleLowerCase())) {
          throw new UserFacingError(`A channel or category named **${escapeDiscordText(action.name)}** already exists in this plan or server.`);
        }
        if (action.channelType === "category" && action.category !== null) {
          throw new UserFacingError("A category cannot be created inside another category.");
        }
        if (action.category) {
          const createdParent = plannedChannels.get(action.category.toLocaleLowerCase());
          if (createdParent !== undefined) {
            if (createdParent.type !== ChannelType.GuildCategory) throw new UserFacingError("Choose a category as the parent.");
          } else {
            resolveChannel(action.category, channels, [ChannelType.GuildCategory]);
          }
        }
        plannedChannels.set(action.name.toLocaleLowerCase(), {
          type: action.channelType === "category"
            ? ChannelType.GuildCategory
            : action.channelType === "voice"
              ? ChannelType.GuildVoice
              : ChannelType.GuildText,
          id: null,
        });
        break;
      }
      case "channel_rename": {
        const oldName = action.channel.toLocaleLowerCase();
        const newName = action.name.toLocaleLowerCase();
        const channel = plannedChannels.get(oldName);
        const reference = channel ?? (() => {
          const existing = resolveChannel(action.channel, channels);
          return { type: existing.type, id: existing.id };
        })();
        const existingName = channels.find((item) =>
          item.id !== reference.id && item.name.toLocaleLowerCase() === newName);
        const plannedName = plannedChannels.get(newName);
        if (existingName || (plannedName && plannedName.id !== reference.id)) {
          throw new UserFacingError(`A channel or category named **${escapeDiscordText(action.name)}** already exists.`);
        }
        plannedChannels.set(oldName, reference);
        plannedChannels.set(newName, reference);
        break;
      }
      case "channel_move":
        if (!plannedChannels.has(action.channel.toLocaleLowerCase())) resolveChannel(action.channel, channels);
        break;
      case "role_assign":
      case "role_remove": {
        await requirePermission(interaction, guild, PermissionFlagsBits.ManageRoles, "Manage Roles");
        if (!mentionedMemberIds.has(action.memberId)) {
          throw new UserFacingError("Mention the member explicitly in your request before changing their role.");
        }
        const role = resolveRole(action.role, roles.values());
        await checkRoleHierarchy(interaction, guild, role);
        await guild.members.fetch(action.memberId);
        break;
      }
      case "message_send": {
        const planned = plannedChannels.get(action.channel.toLocaleLowerCase());
        if (planned) {
          if (planned.type !== ChannelType.GuildText) {
            throw new UserFacingError(`**${escapeDiscordText(action.channel)}** is not a text channel.`);
          }
          if (planned.id !== null) {
            const channel = resolveChannel(planned.id, channels, [ChannelType.GuildText]);
            const botMember = guild.members.me ?? await guild.members.fetchMe();
            const permissions = channel.permissionsFor(botMember);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
              throw new UserFacingError(`The bot needs View Channel and Send Messages permission in **${escapeDiscordText(channel.name)}**.`);
            }
          }
        } else {
          const channel = resolveChannel(action.channel, channels, [ChannelType.GuildText]);
          const botMember = guild.members.me ?? await guild.members.fetchMe();
          const permissions = channel.permissionsFor(botMember);
          if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
            throw new UserFacingError(`The bot needs View Channel and Send Messages permission in **${escapeDiscordText(channel.name)}**.`);
          }
        }
        break;
      }
    }
  }
}

async function executeRequestAction(
  interaction: ButtonInteraction,
  guild: Guild,
  action: RequestAction,
  createdChannels: Map<string, string>,
): Promise<string> {
  if (action.kind.startsWith("channel_")) {
    await requirePermission(interaction, guild, PermissionFlagsBits.ManageChannels, "Manage Channels");
  }

  switch (action.kind) {
    case "channel_create": {
      let selectedCategory: GuildBasedChannel | null = null;
      if (action.category) {
        const categoryId = createdChannels.get(action.category.toLocaleLowerCase());
        selectedCategory = categoryId
          ? await guild.channels.fetch(categoryId)
          : resolveChannel(action.category, await fetchGuildChannels(guild), [ChannelType.GuildCategory]);
        if (!selectedCategory) throw new UserFacingError("The selected category no longer exists.");
      }
      if (selectedCategory && selectedCategory.type !== ChannelType.GuildCategory) {
        throw new UserFacingError("Choose a category as the parent.");
      }
      const type = action.channelType === "text"
        ? ChannelType.GuildText
        : action.channelType === "voice"
          ? ChannelType.GuildVoice
          : ChannelType.GuildCategory;
      const created = await guild.channels.create({
        name: action.name,
        type,
        ...(selectedCategory && selectedCategory.type === ChannelType.GuildCategory ? { parent: selectedCategory.id } : {}),
        reason: `Created by ${interaction.user.tag} through /request`,
      });
      createdChannels.set(action.name.toLocaleLowerCase(), created.id);
      if (action.position !== null) await created.setPosition(action.position);
      return `Created **${escapeDiscordText(created.name)}**.`;
    }
    case "channel_rename": {
      const channelId = createdChannels.get(action.channel.toLocaleLowerCase());
      const channel = channelId
        ? await guild.channels.fetch(channelId)
        : resolveChannel(action.channel, await fetchGuildChannels(guild));
      if (!channel || channel.isThread()) throw new UserFacingError("That channel no longer exists.");
      await channel.setName(action.name, `Renamed by ${interaction.user.tag} through /request`);
      createdChannels.set(action.channel.toLocaleLowerCase(), channel.id);
      createdChannels.set(action.name.toLocaleLowerCase(), channel.id);
      return `Renamed **${escapeDiscordText(action.channel)}** to **${escapeDiscordText(action.name)}**.`;
    }
    case "channel_move": {
      const channelId = createdChannels.get(action.channel.toLocaleLowerCase());
      const channel = channelId
        ? await guild.channels.fetch(channelId)
        : resolveChannel(action.channel, await fetchGuildChannels(guild));
      if (!channel || channel.isThread()) throw new UserFacingError("That channel no longer exists.");
      await channel.setPosition(action.position, { reason: `Moved by ${interaction.user.tag} through /request` });
      return `Moved **${escapeDiscordText(action.channel)}** to position ${action.position}.`;
    }
    case "role_assign":
    case "role_remove": {
      await requirePermission(interaction, guild, PermissionFlagsBits.ManageRoles, "Manage Roles");
      const role = resolveRole(action.role, (await guild.roles.fetch()).values());
      await checkRoleHierarchy(interaction, guild, role);
      const member = await guild.members.fetch(action.memberId);
      if (action.kind === "role_assign") {
        await member.roles.add(role, `Assigned by ${interaction.user.tag} through /request`);
        return `Assigned **${escapeDiscordText(role.name)}** to member ID \`${action.memberId}\`.`;
      }
      await member.roles.remove(role, `Removed by ${interaction.user.tag} through /request`);
      return `Removed **${escapeDiscordText(role.name)}** from member ID \`${action.memberId}\`.`;
    }
    case "message_send": {
      const channelId = createdChannels.get(action.channel.toLocaleLowerCase());
      const channel = channelId
        ? await guild.channels.fetch(channelId)
        : resolveChannel(action.channel, await fetchGuildChannels(guild), [ChannelType.GuildText]);
      if (!channel || channel.type !== ChannelType.GuildText) throw new UserFacingError("Choose a text channel.");
      const botMember = guild.members.me ?? await guild.members.fetchMe();
      const permissions = channel.permissionsFor(botMember);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        throw new UserFacingError(`The bot cannot send messages in **${escapeDiscordText(channel.name)}**.`);
      }
      await channel.send({ content: action.content, allowedMentions: { parse: [] } });
      return `Posted the requested message in **${escapeDiscordText(channel.name)}**.`;
    }
  }
}

async function handleRequest(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild || guild.id !== guildId) {
    await interaction.reply({ content: "This bot is configured for a different server.", ephemeral: true });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "You need the **Administrator** permission to use `/request`.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  let pendingId: string | undefined;
  try {
    const description = interaction.options.getString("description", true);
    const snapshot = await loadServerSnapshot(guild);
    const plan = await createRequestPlan(description, snapshot);
    if (plan.status !== "ready") {
      await interaction.editReply({ content: escapeDiscordText(plan.summary), allowedMentions: { parse: [] } });
      return;
    }

    const mentionedMemberIds = [...getMentionedMemberIds(description)];
    await validateRequestPlan(interaction, guild, plan.actions, new Set(mentionedMemberIds));
    for (const [id, request] of pendingRequests) {
      if (request.expiresAt <= Date.now()) pendingRequests.delete(id);
    }
    if (pendingRequests.size >= 100) throw new UserFacingError("Too many pending requests. Wait for one to expire and try again.");

    const id = randomUUID();
    const rows = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`request:approve:${id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`request:cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    );
    const steps = plan.actions.map((action, index) => `${index + 1}. ${actionSummary(action)}`).join("\n");
    const preview = `**Proposed actions**\n${escapeDiscordText(plan.summary)}\n\n${steps}\n\nNo changes will be made unless you approve. Buttons expire in 5 minutes.`;
    if (preview.length > 2000) throw new UserFacingError("This plan is too long to review safely. Split it into smaller requests.");
    pendingRequests.set(id, {
      guildId: guild.id,
      requesterId: interaction.user.id,
      actions: plan.actions,
      mentionedMemberIds,
      expiresAt: Date.now() + requestLifetimeMs,
    });
    pendingId = id;
    await interaction.editReply({
      content: preview,
      components: [rows],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (pendingId) pendingRequests.delete(pendingId);
    if (error instanceof UserFacingError) {
      await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } });
      return;
    }
    console.error("Could not plan /request:", error);
    await interaction.editReply("I couldn't safely plan this request, so no changes were made. Check Copilot sign-in and the bot logs.");
  }
}

async function handleRequestButton(interaction: ButtonInteraction): Promise<void> {
  const [, decision, id] = interaction.customId.split(":");
  if ((decision !== "approve" && decision !== "cancel") || !id) return;
  const request = pendingRequests.get(id);
  if (!request || request.expiresAt <= Date.now()) {
    pendingRequests.delete(id);
    await interaction.reply({ content: "This request has expired. Run `/request` again.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== request.requesterId) {
    await interaction.reply({ content: "Only the person who created this request can approve or cancel it.", ephemeral: true });
    return;
  }
  if (decision === "cancel") {
    pendingRequests.delete(id);
    await interaction.update({ content: "Request cancelled. No changes were made.", components: [] });
    return;
  }

  const guild = interaction.guild;
  if (!guild || guild.id !== request.guildId || guild.id !== guildId) {
    pendingRequests.delete(id);
    await interaction.update({ content: "This request is no longer available in this server.", components: [] });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    pendingRequests.delete(id);
    await interaction.update({ content: "Your Administrator permission changed. No changes were made.", components: [] });
    return;
  }

  pendingRequests.delete(id);
  await interaction.deferUpdate();
  const completed: string[] = [];
  const createdChannels = new Map<string, string>();
  try {
    await validateRequestPlan(interaction, guild, request.actions, new Set(request.mentionedMemberIds));
    for (const action of request.actions) {
      completed.push(await executeRequestAction(interaction, guild, action, createdChannels));
    }
    await interaction.editReply({
      content: `Completed:\n${completed.map((line) => `• ${line}`).join("\n")}`,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Could not complete approved /request:", error);
    const reason = error instanceof UserFacingError ? error.message : "The bot encountered an error.";
    const finished = completed.length
      ? `Completed before stopping:\n${completed.map((line) => `• ${line}`).join("\n")}\n\n`
      : "";
    await interaction.editReply({
      content: `${finished}Stopped: ${escapeDiscordText(reason)}. Check the server because earlier steps may already have succeeded.`,
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "request") {
    await handleRequest(interaction);
    return;
  }

  const guild = interaction.guild;
  if (!guild || guild.id !== guildId) {
    await interaction.reply({ content: "This bot is configured for a different server.", ephemeral: true });
    return;
  }

  const permission = interaction.commandName === "role"
    ? PermissionFlagsBits.ManageRoles
    : PermissionFlagsBits.ManageChannels;
  const permissionLabel = interaction.commandName === "role" ? "Manage Roles" : "Manage Channels";

  try {
    await requirePermission(interaction, guild, permission, permissionLabel);
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === "role") {
      const action = interaction.options.getSubcommand();
      const user = interaction.options.getUser("member", true);
      const selectedRole = interaction.options.getRole("role", true);
      const role = await guild.roles.fetch(selectedRole.id);
      if (!role) throw new UserFacingError("That role no longer exists.");
      await checkRoleHierarchy(interaction, guild, role);

      const member = await guild.members.fetch(user.id);
      if (action === "assign") {
        await member.roles.add(role, `Assigned by ${interaction.user.tag}`);
        await interaction.editReply(`Assigned **${role.name}** to **${user.tag}**.`);
      } else {
        await member.roles.remove(role, `Removed by ${interaction.user.tag}`);
        await interaction.editReply(`Removed **${role.name}** from **${user.tag}**.`);
      }
      return;
    }

    const action = interaction.options.getSubcommand();
    const selectedChannel = interaction.options.getChannel("channel");
    const channel = selectedChannel ? await guild.channels.fetch(selectedChannel.id) : null;

    if (action === "rename") {
      if (!channel || channel.isThread()) {
        throw new UserFacingError("Choose a server channel, not a thread or DM.");
      }
      const name = interaction.options.getString("name", true).trim();
      if (!name) throw new UserFacingError("Channel name cannot be blank.");
      await channel.setName(name, `Renamed by ${interaction.user.tag}`);
      await interaction.editReply(`Renamed the channel to **${name}**.`);
      return;
    }

    if (action === "move") {
      if (!channel || channel.isThread()) {
        throw new UserFacingError("Choose a server channel, not a thread or DM.");
      }
      const position = interaction.options.getInteger("position", true);
      await channel.setPosition(position, { reason: `Reordered by ${interaction.user.tag}` });
      await interaction.editReply(`Moved **${channel.name}** to position **${position}**.`);
      return;
    }

    const name = interaction.options.getString("name", true).trim();
    if (!name) throw new UserFacingError("Channel name cannot be blank.");
    const type = interaction.options.getString("type", true);
    const selectedCategory = interaction.options.getChannel("category");
    const category = selectedCategory ? await guild.channels.fetch(selectedCategory.id) : null;
    if (category && (category.isThread() || category.type !== ChannelType.GuildCategory)) {
      throw new UserFacingError("Choose a server category.");
    }
    const parent = type === "category" ? undefined : category?.id;
    const created = await guild.channels.create({
      name,
      type: type === "text"
        ? ChannelType.GuildText
        : type === "voice"
          ? ChannelType.GuildVoice
          : ChannelType.GuildCategory,
      ...(parent ? { parent } : {}),
      reason: `Created by ${interaction.user.tag}`,
    });
    await interaction.editReply(`Created ${created} (**${created.name}**).`);
  } catch (error) {
    if (error instanceof UserFacingError) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(error.message);
      } else {
        await interaction.reply({ content: error.message, ephemeral: true });
      }
      return;
    }

    console.error(`Command /${interaction.commandName} failed:`, error);
    const message = "The command failed. Check the bot's permissions and role hierarchy, then review its logs.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
});
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleRequestButton(interaction);
    } else if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    }
  } catch (error) {
    console.error("Could not handle Discord interaction:", error);
  }
});

async function shutdown(): Promise<void> {
  client.destroy();
  if (copilotStart) await copilotStart;
  if (copilotStarted) {
    const errors = await copilotClient.stop();
    for (const error of errors) console.error("Could not stop Copilot runtime:", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error) => {
      console.error("Could not stop bot cleanly:", error);
      process.exitCode = 1;
    });
  });
}

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
console.log(`Registered server commands for guild ${guildId}.`);
await client.login(token);
