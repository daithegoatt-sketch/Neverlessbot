'use strict';

const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const DATA_CHANNEL_NAME = 'neverless-data';
const PREFIX = 'NLFRIEND1|';
const REQUEST_TTL = 5 * 60 * 1000;
const THEME = 0x17365d;
const ALLOWED_CHANNELS = new Set(['1548665575247581184', '1548665662556217384', '1548983198120419418']);
const friendships = new Map();
const messageIds = new Map();
const loadPromises = new Map();
const locks = new Map();

const ids = (a,b)=>[String(a),String(b)].sort();
const pairKey = (guildId,a,b)=>`${guildId}:${ids(a,b).join(':')}`;
const encode = (value)=>Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
function decode(value){try{return JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));}catch{return null;}}
function pack(friend){return{a:friend.a,b:friend.b,s:friend.since,m:friend.mentions,u:friend.updatedAt,x:friend.active===false?0:1};}
function unpack(value={}){
  if(!/^\d{15,22}$/.test(String(value.a))||!/^\d{15,22}$/.test(String(value.b))||value.a===value.b)return null;
  const [a,b]=ids(value.a,value.b);
  return{a,b,since:Math.max(0,Number(value.s)||Date.now()),mentions:Math.max(0,Math.floor(Number(value.m)||0)),updatedAt:Math.max(0,Number(value.u)||Date.now()),active:value.x!==0};
}
function parseRecord(content){
  const value=String(content||'');if(!value.startsWith(PREFIX))return null;
  const rest=value.slice(PREFIX.length),index=rest.indexOf('|');if(index<0)return null;
  const guildId=rest.slice(0,index),friend=unpack(decode(rest.slice(index+1)));
  return /^\d{15,22}$/.test(guildId)&&friend?{guildId,friend}:null;
}
function dataChannel(guild){return guild.channels.cache.find((c)=>c?.name===DATA_CHANNEL_NAME&&c.isTextBased?.())||null;}
async function loadGuild(guild){
  const channel=dataChannel(guild);if(!channel){console.warn(`[friendship] #${DATA_CHANNEL_NAME} missing in ${guild.name}`);return;}
  const latest=new Map();let before;let scanned=0;
  while(scanned<5000){
    const batch=await channel.messages.fetch({limit:100,before}).catch(()=>null);if(!batch?.size)break;
    for(const msg of batch.values()){if(msg.author?.id!==guild.client.user?.id)continue;const record=parseRecord(msg.content);if(!record||record.guildId!==guild.id)continue;const key=pairKey(guild.id,record.friend.a,record.friend.b),old=latest.get(key);if(!old||msg.createdTimestamp>old.ts)latest.set(key,{...record,id:msg.id,ts:msg.createdTimestamp});}
    scanned+=batch.size;before=batch.last()?.id;if(batch.size<100)break;
  }
  for(const [key,record] of latest){friendships.set(key,record.friend);messageIds.set(key,record.id);}
  console.log(`[friendship] loaded ${latest.size} records in ${guild.name}`);
}
function ensureLoaded(guild){if(!loadPromises.has(guild.id))loadPromises.set(guild.id,loadGuild(guild).catch((e)=>console.error('[friendship] load:',e)));return loadPromises.get(guild.id);}
async function locked(guildId,fn){
  const prev=locks.get(guildId)||Promise.resolve();let release;const gate=new Promise((r)=>{release=r;});const next=prev.catch(()=>{}).then(()=>gate);locks.set(guildId,next);await prev.catch(()=>{});
  try{return await fn();}finally{release();if(locks.get(guildId)===next)locks.delete(guildId);}
}
async function persist(guild,friend){
  const channel=dataChannel(guild);if(!channel)return false;const key=pairKey(guild.id,friend.a,friend.b);friend.updatedAt=Date.now();const content=`${PREFIX}${guild.id}|${encode(pack(friend))}`;
  let msg=messageIds.get(key)?await channel.messages.fetch(messageIds.get(key)).catch(()=>null):null;
  try{if(msg)await msg.edit({content,allowedMentions:{parse:[]}});else msg=await channel.send({content,allowedMentions:{parse:[]}});}catch(error){console.error('[friendship] persist:',error);return false;}
  if(msg)messageIds.set(key,msg.id);return Boolean(msg);
}
function clean(content){return String(content||'').trim().replace(/^[-#]+\s*/u,'').replace(/\s+/g,' ').toLowerCase();}
function buttons(nonce,disabled=false){return[new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`nlfriend:${nonce}:accept`).setLabel('قبول').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
  new ButtonBuilder().setCustomId(`nlfriend:${nonce}:reject`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled)
)];}
function days(since){return Math.max(0,Math.floor((Date.now()-since)/86400000));}
function date(at,style='D'){return `<t:${Math.floor(at/1000)}:${style}>`;}
async function request(message){
  const target=message.mentions.users.first();
  if(!target||target.bot||target.id===message.author.id){await message.reply({content:'الاستخدام: `طلب صداقة @member`',allowedMentions:{repliedUser:false}});return;}
  const key=pairKey(message.guildId,message.author.id,target.id);
  if(friendships.get(key)?.active){await message.reply({content:`أنت و <@${target.id}> أصدقاء بالفعل.`,allowedMentions:{repliedUser:false,users:[target.id]}});return;}
  const nonce=crypto.randomBytes(6).toString('hex');
  const embed=new EmbedBuilder().setColor(THEME).setTitle('🤝 طلب صداقة').setDescription(`<@${message.author.id}> يطلب صداقة <@${target.id}>`)
    .setThumbnail(message.author.displayAvatarURL({extension:'png',size:256})).setImage(target.displayAvatarURL({extension:'png',size:512}))
    .addFields({name:'المرسل',value:message.author.globalName||message.author.username,inline:true},{name:'المستلم',value:target.globalName||target.username,inline:true}).setFooter({text:'الطلب ينتهي بعد 5 دقائق'});
  const sent=await message.reply({embeds:[embed],components:buttons(nonce),allowedMentions:{repliedUser:false,users:[target.id]}});
  const collector=sent.createMessageComponentCollector({time:REQUEST_TTL});
  collector.on('collect',async(interaction)=>{
    if(interaction.user.id!==target.id){await interaction.reply({content:'هذا الطلب موجه لشخص آخر.',ephemeral:true}).catch(()=>{});return;}
    collector.stop('answered');const accepted=interaction.customId.endsWith(':accept');await interaction.deferUpdate().catch(()=>{});
    if(accepted)await locked(message.guildId,async()=>{const [a,b]=ids(message.author.id,target.id);const friend={a,b,since:Date.now(),mentions:0,updatedAt:Date.now(),active:true};friendships.set(key,friend);await persist(message.guild,friend);});
    const result=EmbedBuilder.from(embed).setColor(accepted?0x22c55e:0xef4444).setTitle(accepted?'✅ تم قبول الصداقة':'❌ تم رفض الصداقة').setDescription(accepted?`<@${message.author.id}> و <@${target.id}> أصبحا أصدقاء الآن.`:`<@${target.id}> رفض طلب الصداقة.`);
    await sent.edit({embeds:[result],components:buttons(nonce,true),allowedMentions:{users:[]}}).catch(()=>{});
  });
  collector.on('end',async(_,reason)=>{if(reason!=='answered')await sent.edit({components:buttons(nonce,true)}).catch(()=>{});});
}
async function info(message){
  const target=message.mentions.users.first();if(!target||target.id===message.author.id){await message.reply({content:'الاستخدام: `صداقة @member`',allowedMentions:{repliedUser:false}});return;}
  const friend=friendships.get(pairKey(message.guildId,message.author.id,target.id));
  if(!friend?.active){await message.reply({content:`لا توجد صداقة مسجلة بينك وبين <@${target.id}>.`,allowedMentions:{repliedUser:false,users:[target.id]}});return;}
  const embed=new EmbedBuilder().setColor(THEME).setTitle('🤝 بطاقة الصداقة').setDescription(`<@${message.author.id}>  💙  <@${target.id}>`)
    .setThumbnail(message.author.displayAvatarURL({extension:'png',size:256})).setImage(target.displayAvatarURL({extension:'png',size:512}))
    .addFields({name:'📅 أول يوم صداقة',value:date(friend.since),inline:true},{name:'⏳ أيام الصداقة',value:`${days(friend.since)} يوم`,inline:true},{name:'📣 المنشنات المتبادلة',value:friend.mentions.toLocaleString('en-US'),inline:true})
    .setFooter({text:'يبدأ عد المنشنات من وقت قبول الصداقة'});
  await message.reply({embeds:[embed],allowedMentions:{repliedUser:false,users:[]}});
}
async function list(message){
  const rows=[];for(const friend of friendships.values()){if(!friend.active||![friend.a,friend.b].includes(message.author.id))continue;rows.push({otherId:friend.a===message.author.id?friend.b:friend.a,...friend,days:days(friend.since)});}
  rows.sort((a,b)=>b.days-a.days||a.since-b.since);
  const lines=rows.slice(0,25).map((row,index)=>`**${index+1}.** <@${row.otherId}> — **${row.days} يوم** • ${date(row.since)}`);
  const embed=new EmbedBuilder().setColor(THEME).setAuthor({name:message.author.globalName||message.author.username,iconURL:message.author.displayAvatarURL({extension:'png',size:256})}).setTitle('👥 قائمة الأصدقاء').setDescription(lines.join('\n')||'لا يوجد أصدقاء مسجلون حتى الآن.').addFields({name:'الإجمالي',value:String(rows.length),inline:true});
  await message.reply({embeds:[embed],allowedMentions:{repliedUser:false,users:[]}});
}
async function remove(message){
  const target=message.mentions.users.first();if(!target||target.id===message.author.id){await message.reply({content:'الاستخدام: `حذف صديق @member`',allowedMentions:{repliedUser:false}});return;}
  const key=pairKey(message.guildId,message.author.id,target.id),friend=friendships.get(key);if(!friend?.active){await message.reply({content:`لا توجد صداقة مسجلة مع <@${target.id}>.`,allowedMentions:{repliedUser:false,users:[target.id]}});return;}
  await locked(message.guildId,async()=>{friend.active=false;await persist(message.guild,friend);});
  await message.reply({content:`✅ تم حذف <@${target.id}> من قائمة أصدقائك.`,allowedMentions:{repliedUser:false,users:[target.id]}});
}
async function trackMentions(message){
  if(!message?.guildId||message.author?.bot||!message.mentions?.users?.size)return;await ensureLoaded(message.guild);const touched=[];
  for(const target of message.mentions.users.values()){if(target.bot||target.id===message.author.id)continue;const friend=friendships.get(pairKey(message.guildId,message.author.id,target.id));if(friend?.active)touched.push(friend);}
  if(!touched.length)return;await locked(message.guildId,async()=>{for(const friend of touched){friend.mentions+=1;await persist(message.guild,friend);}});
}
async function handleMessage(message){
  if(!message?.guildId||message.author?.bot)return false;
  trackMentions(message).catch((e)=>console.error('[friendship] mention tracking:',e));
  if(!ALLOWED_CHANNELS.has(message.channelId))return false;const text=clean(message.content);
  if(!/^(?:طلب صداقة|friendship req|friend request|صداقة|صادقة|friendship|قائمة الأصدقاء|friends|حذف صديق|remove friend)(?:\s|$)/u.test(text))return false;
  await ensureLoaded(message.guild);
  if(/^(?:طلب صداقة|friendship req|friend request)(?:\s|$)/u.test(text)){await request(message);return true;}
  if(/^(?:قائمة الأصدقاء|friends)$/u.test(text)){await list(message);return true;}
  if(/^(?:حذف صديق|remove friend)(?:\s|$)/u.test(text)){await remove(message);return true;}
  await info(message);return true;
}
function installFriendshipSystem(client){
  if(client.__neverlessFriendshipInstalled)return;client.__neverlessFriendshipInstalled=true;
  client.on('messageCreate',(message)=>handleMessage(message).catch((e)=>console.error('[friendship] command:',e)));
  console.log('[friendship] installed');
}

module.exports={installFriendshipSystem,handleMessage,parseRecord,unpack,pairKey,ALLOWED_CHANNELS};
