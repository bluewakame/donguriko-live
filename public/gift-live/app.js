const stage=document.getElementById('stage'),particles=document.getElementById('particles'),video=document.getElementById('avatarVideo'),lip=document.getElementById('lipLayer');
const gifts={idle:['♡','遊びに来てくれてありがとう','ゆったり配信中','♥',0],rose:['🌹','バラ、ありがとう！','バラにお礼中','🌹',20],heart:['♡','ハート、受け取ったよ','ハートをお返し中','♥',28],confetti:['✦','お祝いありがとう！','お祝い中','✦',50],fireworks:['✺','花火、すごい！','花火にリアクション中','✺',60],universe:['✧','ユニバース！？ありがとう！','スペシャルギフトに感謝中','✦',80]};
let timer,lastGift='',lastToken='',ctx,source,analyser,samples,envelope=[],envelopeStart=0,envelopeFrame=40,speaking=false;
function react(kind='idle',from=''){const [icon,title,mode,symbol,count]=gifts[kind]||gifts.heart;stage.dataset.reaction=kind;document.getElementById('giftIcon').textContent=icon;document.getElementById('giftTitle').textContent=title;document.getElementById('giftFrom').textContent=from?`${from} さんからのギフト`:'WELCOME GIFT';document.getElementById('modeLabel').textContent=mode;particles.replaceChildren();for(let i=0;i<count;i++){let p=document.createElement('span');p.className='particle';p.textContent=symbol;p.style.setProperty('--x',`${Math.random()*100}%`);p.style.setProperty('--s',`${14+Math.random()*22}px`);p.style.setProperty('--d',`${2.4+Math.random()*2.7}s`);p.style.setProperty('--delay',`${Math.random()*1.5}s`);p.style.setProperty('--c',kind==='universe'?'#d9bdff':'#ffd3d8');particles.append(p)}let file=kind==='idle'?'avatar-idle.mp4?v=breath2':'avatar-loop.mp4?v=breath2';if(video.dataset.file!==file){video.dataset.file=file;video.src=file;video.load();video.play().catch(()=>{})}clearTimeout(timer);if(kind!=='idle')timer=setTimeout(()=>react('idle'),6500)}
document.querySelectorAll('[data-gift]').forEach(b=>b.onclick=()=>react(b.dataset.gift));
function giftKind(s){s=String(s).toLowerCase();if(/universe|galaxy|rocket|ユニバース|ギャラクシー/.test(s))return'universe';if(/firework|花火/.test(s))return'fireworks';if(/confetti|紙吹雪/.test(s))return'confetti';if(/rose|rosa|バラ/.test(s))return'rose';return'heart'}
async function playSpeech(token){try{ctx??=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();let response=await fetch(`/audio/last.wav?t=${encodeURIComponent(token)}`,{cache:'no-store'});if(!response.ok)return;let buffer=await ctx.decodeAudioData(await response.arrayBuffer());if(source){source.onended=null;try{source.stop()}catch{}}source=ctx.createBufferSource();source.buffer=buffer;analyser=ctx.createAnalyser();analyser.fftSize=1024;samples=new Uint8Array(analyser.fftSize);source.connect(analyser);analyser.connect(ctx.destination);source.onended=()=>{analyser=null;source=null};source.start()}catch(e){console.warn(e)}}
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
let smoothMouth=0,lastMouthFrame=0;
function mouth(now){
  if(analyser&&samples){
    analyser.getByteTimeDomainData(samples);
    let sum=0;
    for(let x of samples){x=(x-128)/128;sum+=x*x}
    return clamp(Math.sqrt(sum/samples.length)*5.5,0,1);
  }
  if(envelope.length){
    const position=(now-envelopeStart)/envelopeFrame;
    if(position>=0&&position<envelope.length){
      const start=Math.floor(position),fraction=position-start;
      const a=envelope[start]||0,b=envelope[Math.min(start+1,envelope.length-1)]||0;
      return clamp(a+(b-a)*fraction,0,1);
    }
  }
  return 0;
}
function draw(now){
  const elapsed=lastMouthFrame?clamp(now-lastMouthFrame,0,64):16;
  lastMouthFrame=now;
  const level=mouth(now);
  const target=level<0.015?0:0.1+Math.pow(level,0.65)*0.9;
  const response=target>smoothMouth?55:105;
  smoothMouth+=(target-smoothMouth)*(1-Math.exp(-elapsed/response));
  lip.style.opacity=String(clamp(smoothMouth,0,1));
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
function onState(s){let t=String(s.commentText||''),signature=`${s.commentAuthor}|${t}`;if(s.commentService==='TikTok'&&t.startsWith('ギフト「')&&signature!==lastGift){lastGift=signature;react(giftKind(t),s.commentAuthor||'視聴者')}speaking=!!s.isSpeaking;if(s.replyText&&speaking)document.getElementById('giftLine').textContent=s.replyText;if(s.audioToken&&s.audioToken!==lastToken){lastToken=s.audioToken;envelope=Array.isArray(s.mouthEnvelope)?s.mouthEnvelope:[];envelopeFrame=s.mouthFrameMs||40;envelopeStart=performance.now()+(s.lipSyncOffsetMs||0);if(s.browserAudio)playSpeech(s.audioToken)}}
if(new URLSearchParams(location.search).get('obs')==='1')document.body.classList.add('obs');try{let stream=new EventSource('/events');stream.onmessage=e=>onState(JSON.parse(e.data))}catch{}window.GiftLive={react,giftKind};
