# NeverLess Discord Bot

بوت إدارة مخصص لسيرفر **NeverLess** ومجهز للنشر على Railway.

## المزايا الحالية

- Welcome مخصص بصورة NeverLess: صورة العضو + اسمه + رقم العضو الحالي.
- تتبع رابط الدعوة المستخدم قدر الإمكان وإظهار الداعي.
- Embed للقوانين مع نص وصورة.
- نظام Tickets كامل: شكوى/مشكلة، اقتراح، استفسار، صلاحيات خاصة، Lock، Leave، وحفظ Transcript بصيغة HTML.
- أوامر إدارة: Kick، Ban، Lock، Unlock، Clear، Move.
- رومات صوتية مؤقتة: إنشاء تلقائي، تحديد الحد، قفل وفتح الروم، وحذف الروم عندما يصبح فارغاً.

## أوامر الإعداد

- `/welcome channel` — تحديد روم الترحيب.
- `/rules channel rules image_url` — إرسال Embed القوانين.
- `/ticket-setup channel category support_role image_url?` — إعداد لوحة التذاكر.
- `/tempvoice category_name? lobby_name?` — إنشاء نظام الرومات الصوتية المؤقتة.

## أوامر الإدارة

- `/kick`
- `/ban`
- `/lock`
- `/unlock`
- `/clear`
- `/move`

## Railway

1. اربط Railway بهذا المستودع.
2. أضف المتغير `DISCORD_TOKEN` وضع فيه Token البوت من Discord Developer Portal.
3. Start command هو `npm start`.
4. يفضل إضافة Railway Volume بمسار `/data` ثم إضافة المتغير `DATA_DIR=/data` حتى تبقى إعدادات الرومات محفوظة بعد إعادة التشغيل أو إعادة النشر.

## إعداد Discord Developer Portal

فعّل للبوت:

- Server Members Intent
- Message Content Intent

وعند إنشاء رابط دعوة البوت استخدم `bot` و `applications.commands`، وأعطه الصلاحيات اللازمة لإدارة الرومات والرسائل والأعضاء والصوت والتذاكر. يجب أن تكون رتبة البوت أعلى من الأعضاء الذين تريد أن يتمكن من طردهم أو حظرهم.

## Welcome Image

القالب موجود في:

`assets/welcome-template.jpg`

أبعاد القالب: **1672 × 941**. البوت يضع صورة العضو داخل الدائرة، ويكتب الاسم في المساحة المخصصة، ويضيف `MEMBER #xxxx` حسب عدد أعضاء السيرفر وقت الدخول.

## ملاحظة Invite Tracking

Discord لا يرسل اسم الداعي مباشرة مع حدث دخول العضو. البوت يقارن عدد استخدامات روابط الدعوة قبل وبعد الدخول، لذلك قد يظهر `Unknown` في بعض الحالات مثل Vanity Invite أو تغييرات/دخولات متزامنة لا يمكن نسبتها بدقة.
