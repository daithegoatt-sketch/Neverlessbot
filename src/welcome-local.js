const { createCanvas, loadImage } = require('@napi-rs/canvas');
async function test(){ const c=createCanvas(10,10); const i=await loadImage('assets/welcome-template.jpg'); c.getContext('2d').drawImage(i,0,0,10,10); return c.toBuffer('image/png'); }
module.exports={test};
