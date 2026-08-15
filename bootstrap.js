const { Client, PermissionFlagsBits } = require('discord.js');

const AUTO_ROLE_NAME = 'Neverless';
const originalLogin = Client.prototype.login;

Client.prototype.login = function neverlessLogin(token) {
  if (!this.__neverlessAutoRoleInstalled) {
    this.__neverlessAutoRoleInstalled = true;

    this.on('guildMemberAdd', async (member) => {
      // Auto-role is intended for real server members, not bots.
      if (member.user.bot) return;

      try {
        const role = member.guild.roles.cache.find((item) => item.name === AUTO_ROLE_NAME);
        if (!role) {
          console.warn(`[autorole] Role "${AUTO_ROLE_NAME}" was not found in ${member.guild.name}.`);
          return;
        }

        const botMember = member.guild.members.me;
        if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          console.warn(`[autorole] Missing Manage Roles permission in ${member.guild.name}.`);
          return;
        }

        if (!role.editable) {
          console.warn(`[autorole] Cannot assign "${AUTO_ROLE_NAME}" because the bot role is not above it.`);
          return;
        }

        if (member.roles.cache.has(role.id)) return;

        await member.roles.add(role, 'NeverLess automatic member role');
        console.log(`[autorole] Assigned ${AUTO_ROLE_NAME} to ${member.user.tag}.`);
      } catch (error) {
        console.error(`[autorole] Failed for ${member.user.tag}:`, error);
      }
    });
  }

  return originalLogin.call(this, token);
};

require('./index.js');
