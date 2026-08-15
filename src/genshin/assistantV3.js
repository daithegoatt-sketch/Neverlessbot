'use strict';

const { getGuideByText } = require('./guides');
const { getGuide } = require('./guideClient');
const { getCharacterNames, getCharacter, getCharacterStats } = require('./dataClient');
const { getLinkedUid, linkUid, unlinkUid } = require('./accountStore');
const { fetchAccount, findCharacter, getBuildSnapshot, listCharacters, accountSummary } = require('./enkaClient');
const { evaluateBuild, compareSnapshots } = require('./buildEvaluator');
const { getPrevious, record } = require('./buildHistory');
const { buildRatingCard } = require('./buildCard');
const { fetchAkashaPercentile } = require('./akashaClient');
const R = require('./responses');

const CHANNEL_ID = process.env.GENSHIN_CHANNEL_ID || '1538091335079297034';
const TTL = 30 * 60 * 1000;
const sessions = new Map();
const cooldowns = new Map();

function sk(m) { return `${m.guildId}:${m.author.id}`; }
function session(m) {
  const old = sessions.get(sk(m));
  if (old && Date.now() - old.at < TTL) return old;
  const fresh = { at: Date.now(), lastIntent: null, lastCharacter: null, team: null };
  sessions.set(sk(m), fresh);
  return fresh;
}
function save(m, patch) { const n = { ...session(m), ...patch, at: Date.now() }; sessions.set(sk(m), n); return n; }
function language(t) {
  const a = (String(t).match(/[\u0600-\u06ff]/g) || []).length;
  const e = (String(t).match(/[A-Za-z]/g) || []).length;
  return a && a >= e * 0.25 ? 'ar' : 'en';
}

function skeleton(v) {
  const map = { ا:'a',أ:'a',إ:'a',آ:'a',ب:'b',ت:'t',ث:'th',ج:'j',ح:'h',خ:'kh',د:'d',ذ:'dh',ر:'r',ز:'z',س:'s',ش:'sh',ص:'s',ض:'d',ط:'t',ظ:'z',ع:'',غ:'gh',ف:'f',ق:'q',ك:'k',ل:'l',م:'m',ن:'n',ه:'h',ة:'h',و:'w',ي:'y',ى:'a',ء:'',ئ:'y',ؤ:'w' };
  return [...String(v).toLowerCase()].map(c => map[c] ?? c).join('').replace(/sh/g,'s').replace(/kh/g,'k').replace(/gh/g,'g').replace(/th|dh/g,'t').replace(/[^a-z0-9]/g,'').replace(/[aeiouywh]/g,'').replace(/(.)\1+/g,'$1');
}
function distance(a,b) {
  const d = Array.from({length:b.length+1},()=>Array(a.length+1).fill(0));
  for(let i=0;i<=b.length;i++) d[i][0]=i; for(let j=0;j<=a.length;j++) d[0][j]=j;
  for(let i=1;i<=b.length;i++) for(let j=1;j<=a.length;j++) d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(b[i-1]===a[j-1]?0:1));
  return d[b.length][a.length];
}
async function resolveCharacter(text) {
  const curated = getGuideByText(text); if (curated) return curated.name;
  let names=[]; try { names=await getCharacterNames(); } catch { return null; }
  const low=String(text).toLowerCase();
  const direct=[...names].sort((a,b)=>b.length-a.length).find(n=>low.includes(n.toLowerCase())); if(direct) return direct;
  const tokens=String(text).match(/[\u0600-\u06ff]{3,}(?:\s+[\u0600-\u06ff]{3,})?/g)||[];
  let best=null;
  for(const token of tokens){const l=skeleton(token); if(l.length<3)continue; for(const name of names){const r=skeleton(name); if(r.length<2)continue; const score=1-distance(l,r)/Math.max(l.length,r.length); if(score>=0.68&&(!best||score>best.score))best={name,score};}}
  return best?.name||null;
}
async function mentioned(text) {
  let names=[]; try { names=await getCharacterNames(); } catch { return []; }
  const low=String(text).toLowerCase(); return [...names].sort((a,b)=>b.length-a.length).filter(n=>low.includes(n.toLowerCase()));
}

function intent(text) {
  const t=String(text).trim(), uid=t.match(/\b\d{9,10}\b/)?.[0]||null;
  const f2p=/\bf2p\b|free.?to.?play|مجاني|مجانية|فري تو بلاي/i.test(t), account=/بحسابي|من حسابي|my account/i.test(t);
  if(/فك\s*(?:ربط)?\s*(?:ال)?uid|الغاء\s*ربط|إلغاء\s*ربط|\bunlink\b|remove\s+uid/iu.test(t))return{type:'unlink',uid,f2p,account};
  if((uid&&(/\buid\b/i.test(t)|/ربط/iu.test(t)|/^\/?link\b/i.test(t)))||/^uid\s*\d{9,10}$/i.test(t))return{type:'link',uid,f2p,account};
  if(/^(?:ربط|\/?link|uid)\s*$/iu.test(t))return{type:'linkPrompt',uid,f2p,account};
  if(/شخصياتي|شخصيات حسابي|my characters|my showcase/i.test(t))return{type:'characters',uid,f2p,account:true};
  if(account&&/قارن|مقارنة|مقارنه|compare|السابق|القديم/i.test(t))return{type:'compare',uid,f2p,account:true};
  if(account&&/تقييم|قيّم|قيم|رأيك|رايك|شرايك|حلل|rating|rate|analy[sz]e|what do you think/i.test(t))return{type:'rate',uid,f2p,account:true};
  if(/\bteam\b|\bteams\b|\bcomp\b|تيم|فريق|تشكيل|تركيب/iu.test(t))return{type:'team',uid,f2p,account};
  if(/combo|rotation|روتيشن|كومبو|طريقة اللعب|طريقه اللعب/iu.test(t))return{type:'combo',uid,f2p,account};
  if(/ما\s*عندي|ما\s*املك|ما\s*أملك|بدون|i\s+don'?t\s+have|dont\s+have|without/i.test(t))return{type:'missing',uid,f2p,account};
  if(/^عندي\b|^املك\b|^أملك\b|^i\s+have\b/i.test(t))return{type:'owned',uid,f2p,account};
  if(/base\s*stats?|بيانات(?:\s+اساسية|\s+أساسية)?|الإحصائيات\s+الأساسية/iu.test(t))return{type:'base',uid,f2p,account};
  if(/ارتيفاكت|ارتيفكت|ارتي|artifact|artifacts|طقم/iu.test(t))return{type:'artifacts',uid,f2p,account};
  if(/weapon|weapons|سلاح|اسلحة|أسلحة/iu.test(t))return{type:'weapons',uid,f2p,account};
  if(/\bstats?\b|ستات|احصائيات|إحصائيات|crit|كريت|\ber\b|energy recharge|\bem\b|elemental mastery|\batk\b|attack|\bhp\b/iu.test(t))return{type:'stats',uid,f2p,account};
  if(/بيلد|\bbuild\b/iu.test(t))return{type:'build',uid,f2p,account};
  if(/رأيك|رايك|شرايك|what do you think|opinion/iu.test(t))return{type:'opinion',uid,f2p,account};
  if(/مساعدة|مساعده|\bhelp\b/iu.test(t))return{type:'help',uid,f2p,account};
  return{type:'unknown',uid,f2p,account};
}

function chunks(text,max=1800){const out=[];let cur='';for(const line of String(text).split('\n')){if(cur&&cur.length+line.length+1>max){out.push(cur);cur=line;}else cur=cur?`${cur}\n${line}`:line;}if(cur)out.push(cur);return out;}
async function send(m,text,files=[]){const p=chunks(text);if(!p.length)return;await m.channel.send({content:`<@${m.author.id}> ${p[0]}`,files,allowedMentions:{users:[m.author.id]}});for(const x of p.slice(1))await m.channel.send({content:x});}
async function accountFor(m,lang){const uid=getLinkedUid(m.author.id);if(!uid){await send(m,lang==='ar'?'ما ربطت حسابك. اكتب: `ربط UID 729663359`':'No account is linked. Type `link UID 729663359`.');return null;}try{return{uid,account:await fetchAccount(uid)}}catch(e){console.warn('[genshin] Enka:',e.message);await send(m,lang==='ar'?'ما قدرت أقرأ Enka الآن. تأكد من الـUID وفعّل **Show Character Details** ثم جرّب بعد دقيقة.':'I could not read Enka now. Check the UID, enable **Show Character Details**, and retry.');return null;}}

function pool(g,type){return R.normalizeTeams(g,type).filter(t=>Array.isArray(t)&&t.length===4);}
function rank(teams,main,owned=[],excluded=[]){const o=new Set([main,...owned].map(x=>String(x).toLowerCase())),x=new Set(excluded.map(v=>String(v).toLowerCase()));return teams.filter(t=>!t.some(v=>x.has(String(v).toLowerCase()))).map((team,i)=>{const missing=team.filter(v=>!o.has(String(v).toLowerCase()));return{team,missing,owned:team.length-missing.length,i}}).sort((a,b)=>b.owned-a.owned||a.missing.length-b.missing.length||a.i-b.i);}
function rankedText(char,rows,lang,f2p){const A=lang==='ar',lines=[`**${char} — ${f2p?'F2P':(A?'أنسب التيمات لك':'Best matches')}**`];if(!rows.length)return`${lines[0]}\n${A?'ما لقيت تيم منشور يطابق القيود.':'No published team matches those restrictions.'}`;for(const r of rows.slice(0,4)){lines.push(`• ${r.team.join(' • ')}`);if(r.missing.length)lines.push(`  ${A?'ينقصك':'Missing'}: ${r.missing.join(', ')}`);}return lines.join('\n');}
function same(a,b){const c=x=>JSON.stringify({s:x?.stats,w:x?.weapon,set:x?.setCounts,a:x?.artifacts?.map(i=>[i.slot,i.set,i.mainStat])});return c(a)===c(b);}

async function rate(m,char,lang,compare=false){const linked=await accountFor(m,lang);if(!linked)return;const c=findCharacter(linked.account,char);if(!c){await send(m,lang==='ar'?`**${char}** مو ظاهرة بالتفاصيل في الـShowcase. حطها وفعّل **Show Character Details**.`:`**${char}** is not visible with details in Showcase.`);return;}const g=await getGuide(char);if(!g){await send(m,lang==='ar'?`أقدر أقرأ **${char}** من Enka لكن ما عندي Guide موثوق أقيمه عليه.`:`I can read **${char}**, but I do not have a reliable guide to score it against.`);return;}const snap=getBuildSnapshot(c),ev=evaluateBuild(snap,g),prev=getPrevious(m.author.id,linked.uid,char),cur={snapshot:snap,evaluation:ev},cmp=prev?compareSnapshots(prev,cur):null;if(compare&&!prev){await record(m.author.id,linked.uid,char,cur);await send(m,lang==='ar'?`ما عندي نسخة أقدم لـ **${char}**. حفظت تقييمك الحالي **${ev.score}%**. بعد تعديل البيلد اطلب المقارنة مرة ثانية.`:`No older **${char}** snapshot exists. I saved the current ${ev.score}% score.`);return;}if(!prev||!same(prev.snapshot,snap))await record(m.author.id,linked.uid,char,cur);const ak=await fetchAkashaPercentile(linked.uid,char);let files=[];try{files=[{attachment:await buildRatingCard(c,snap,ev,cmp),name:`${char.replace(/[^a-z0-9]+/gi,'-')}-build.png`}]}catch(e){console.warn('[genshin] card:',e.message)}await send(m,R.accountEvaluationText(snap,ev,cmp,g,lang,ak),files);}

async function handleGenshinMessage(m){
  if(!m?.guildId||m.author?.bot||m.channelId!==CHANNEL_ID)return false;const text=String(m.content||'').trim();if(!text)return false;const now=Date.now(),last=cooldowns.get(m.author.id)||0;if(now-last<1500)return true;cooldowns.set(m.author.id,now);setTimeout(()=>cooldowns.delete(m.author.id),2000).unref?.();
  const lang=language(text),q=intent(text),s=session(m);
  if(q.type==='help'){await send(m,lang==='ar'?'`بيلد Skirk` • `تيم Skirk` • `تيم F2P Skirk` • `كومبو Skirk` • `سلاح F2P Skirk` • `إحصائيات Skirk` • `بيانات Skirk`\n`ربط UID 729663359` ثم `تقييم Skirk بحسابي` أو `قارن بيلد Skirk بحسابي`.':'`Skirk build` • `Skirk team` • `Skirk F2P team` • `Skirk combo` • `Skirk F2P weapons` • `Skirk stats` • `Skirk base stats`\nLink a UID, then rate or compare a showcased build.');return true;}
  if(q.type==='linkPrompt'){await send(m,lang==='ar'?'أرسل الرقم مع الربط: `ربط UID 729663359`':'Include the number: `link UID 729663359`');return true;}
  if(q.type==='unlink'){await unlinkUid(m.author.id);save(m,{lastIntent:'unlink',team:null});await send(m,lang==='ar'?'تم فك ربط حساب Genshin.':'Genshin UID unlinked.');return true;}
  if(q.type==='link'){try{const a=await fetchAccount(q.uid),z=accountSummary(a);await linkUid(m.author.id,q.uid);save(m,{lastIntent:'link',team:null});await send(m,lang==='ar'?`تم ربط **${z.nickname||q.uid}** — AR ${z.adventureRank??'?'} — UID **${q.uid}**.\nEnka شايف **${z.characters.length}** شخصية بالتفاصيل من الـShowcase.${z.characters.length?'\nجرّب: `شخصياتي` أو `تقييم Skirk بحسابي`.':'\nفعّل **Show Character Details** وحط الشخصية بالـShowcase للتحليل.'}`:`Linked **${z.nickname||q.uid}** — AR ${z.adventureRank??'?'} — UID **${q.uid}**. Enka sees ${z.characters.length} detailed Showcase characters.`);}catch(e){console.warn('[genshin] link:',e.message);await send(m,lang==='ar'?'فشل الربط. تأكد من الـUID وأن Enka يقدر يقرأ الحساب.':'Link failed. Check the UID and Enka visibility.');}return true;}
  if(q.type==='characters'){const a=await accountFor(m,lang);if(!a)return true;const cs=listCharacters(a.account);await send(m,`${lang==='ar'?'**شخصيات الـShowcase:**':'**Showcase characters:**'}\n${cs.length?cs.map(c=>`${c.name} Lv.${c.level} C${c.constellation}`).join(' • '):(lang==='ar'?'ما فيه شخصيات ظاهرة بالتفاصيل.':'No detailed characters visible.')}`);return true;}

  if(q.type==='missing'||q.type==='owned'){
    const c=s.team;if(!c||s.lastIntent!=='team'||Date.now()-c.at>TTL){await send(m,lang==='ar'?'إذا تقصد تبديل عضو في تيم، اذكر السياق مثل: `تيم Skirk بدون Yelan`.':'Include the team context, e.g. `Skirk team without Yelan`.');return true;}const ms=await mentioned(text);
    if(q.type==='missing'){let miss=ms;if(!miss.length){const x=await resolveCharacter(text);if(x&&x.toLowerCase()!==c.character.toLowerCase())miss=[x];}if(!miss.length){await send(m,lang==='ar'?'حدد الشخصية اللي ما عندك إياها.':'Name the character you do not have.');return true;}const excluded=[...new Set([...(c.excluded||[]),...miss])],alts=c.teams.filter(t=>!t.some(v=>excluded.some(x=>x.toLowerCase()===String(v).toLowerCase()))),best=R.closestReplacement(c.current,alts,miss);save(m,{lastIntent:'team',team:{...c,excluded,current:best?.team||c.current,at:Date.now()}});await send(m,R.replacementText(c.character,c.current,alts,miss,lang));return true;}
    const owned=[...new Set([c.character,...ms])],rows=rank(c.teams,c.character,owned,c.excluded||[]);save(m,{lastIntent:'team',team:{...c,owned,current:rows[0]?.team||c.current,at:Date.now()}});await send(m,rankedText(c.character,rows,lang,c.kind==='f2p'));return true;
  }

  const char=await resolveCharacter(text);if(!char){await send(m,lang==='ar'?'ما قدرت أحدد الشخصية مع المطلوب. مثال: `بيلد Durin` أو `تيم F2P Skirk`.':'I could not identify the character and request.');return true;}
  if(q.type==='rate'||q.type==='compare'){save(m,{lastIntent:q.type,lastCharacter:char,team:null});await rate(m,char,lang,q.type==='compare');return true;}
  if(q.type==='base'){const [c,st]=await Promise.all([getCharacter(char).catch(()=>null),getCharacterStats(char,'90').catch(()=>null)]);save(m,{lastIntent:'base',lastCharacter:char,team:null});await send(m,c?R.baseText(c,st,lang):(lang==='ar'?`ما لقيت Base Stats لـ **${char}**.`:`No base stats found for **${char}**.`));return true;}
  const g=await getGuide(char);if(!g){await send(m,lang==='ar'?`ما قدرت أجيب Guide موثوق لـ **${char}** الآن، لذلك ما راح أخمّن.`:`No reliable guide is available for **${char}** right now, so I will not guess.`);return true;}
  if(q.type==='team'){const kind=q.f2p?'f2p':'premium',teams=pool(g,kind),ms=(await mentioned(text)).filter(x=>x.toLowerCase()!==char.toLowerCase()),hasMissing=/ما\s*عندي|ما\s*املك|ما\s*أملك|بدون|without|don'?t\s+have/i.test(text);let owned=[],excluded=[];if(q.account){const a=await accountFor(m,lang);if(!a)return true;owned=listCharacters(a.account).map(c=>c.name);}else if(hasMissing)excluded=ms;else if(/عندي|i\s+have/i.test(text))owned=ms;let current=teams[0]||null,response=R.teamText(g,lang,kind);if(owned.length||excluded.length){const rows=rank(teams,char,owned,excluded);current=rows[0]?.team||current;response=rankedText(char,rows,lang,kind==='f2p');}save(m,{lastIntent:'team',lastCharacter:char,team:{character:char,kind,teams,current,owned,excluded,at:Date.now()}});await send(m,response);return true;}
  save(m,{lastIntent:q.type,lastCharacter:char,team:null});
  if(q.type==='artifacts')await send(m,R.artifactsText(g,lang));else if(q.type==='weapons')await send(m,R.weaponsText(g,lang,q.f2p));else if(q.type==='stats')await send(m,R.statsText(g,lang));else if(q.type==='build')await send(m,R.buildText(g,lang,q.f2p));else if(q.type==='combo')await send(m,R.comboText(g,lang));else if(q.type==='opinion')await send(m,R.opinionText(g,lang));else await send(m,lang==='ar'?`عن **${char}** تبي بيلد، تيم، F2P، كومبو، سلاح، ارتيفاكت أو إحصائيات؟`:`For **${char}**, ask for build, team, F2P, combo, weapons, artifacts, or stats.`);return true;
}

module.exports={CHANNEL_ID,handleGenshinMessage,resolveCharacter,intent,language};
