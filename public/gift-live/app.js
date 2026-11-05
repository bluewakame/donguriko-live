const stage=document.getElementById('stage'),particles=document.getElementById('particles'),video=document.getElementById('avatarVideo'),reactionVideo=document.getElementById('reactionVideo'),lip=document.getElementById('lipLayer');
const gifts={
  idle:['♡','遊びに来てくれてありがとう','ゆったり配信中','♥',0,'#ffd3d8'],
  rose:['🌹','バラ、ありがとう！','バラにお礼中','🌹',26,'#ff8aa9'],
  heart:['💗','ハート、受け取ったよ','ハートをお返し中','♥',36,'#ff79b2'],
  confetti:['🎉','お祝いありがとう！','お祝い中','✦',72,'#ffe095'],
  fireworks:['🎆','花火、すごい！','花火にリアクション中','✺',90,'#ffbb6f'],
  crown:['👑','王冠、ありがとう！','キラキラお祝い中','✦',84,'#ffe09a'],
  money:['💸','マネーガン！？ありがとう！','感謝が止まらない','💎',90,'#9dffcb'],
  disco:['🪩','一緒に踊ろう！','ダンス気分','✦',78,'#8ce9ff'],
  rocket:['🚀','ロケット発射！ありがとう！','宇宙へ出発中','✧',100,'#b7b5ff'],
  universe:['🌌','ユニバース！？ありがとう！','スペシャルギフトに感謝中','✦',120,'#d9bdff']
};
let timer,lastGift='',lastToken='',seenState=false,ctx,source,analyser,samples,envelope=[],envelopeStart=0,envelopeFrame=40,speaking=false;
function react(kind='idle',from=''){
  const [icon,title,mode,symbol,count,color]=gifts[kind]||gifts.heart;
  stage.dataset.reaction='idle'; void stage.offsetWidth; stage.dataset.reaction=kind;
  document.getElementById('giftIcon').textContent=icon;
  document.getElementById('giftTitle').textContent=title;
  document.getElementById('giftFrom').textContent=from?`${from} さんからのギフト`:'WELCOME GIFT';
  document.getElementById('modeLabel').textContent=mode;
  particles.replaceChildren();
  const burst=['fireworks','crown','rocket','universe'].includes(kind);
  for(let i=0;i<count;i++){
    const p=document.createElement('span'),angle=Math.random()*Math.PI*2,radius=burst?120+Math.random()*380:0;
    p.className=`particle ${burst?'burst':'float'}`;
    p.textContent=symbol;
    p.style.setProperty('--x',`${Math.random()*100}%`);
    p.style.setProperty('--y',`${Math.random()*90}%`);
    p.style.setProperty('--dx',`${Math.cos(angle)*radius}px`);
    p.style.setProperty('--dy',`${Math.sin(angle)*radius}px`);
    p.style.setProperty('--s',`${12+Math.random()*20}px`);
    p.style.setProperty('--d',`${2.4+Math.random()*2.2}s`);
    p.style.setProperty('--delay',`${Math.random()*(burst?.65:1.2)}s`);
    p.style.setProperty('--c',color);
    particles.append(p);
  }
  // 待機映像は止めず、リアクション映像だけを重ねて滑らかに切り替える。
  if(kind==='idle'){
    stage.classList.remove('reacting');
    setTimeout(()=>{if(!stage.classList.contains('reacting'))reactionVideo.pause()},550);
  }else{
    reactionVideo.currentTime=0;
    reactionVideo.play().catch(()=>{});
    stage.classList.add('reacting');
  }
  clearTimeout(timer);
  if(kind!=='idle')timer=setTimeout(()=>react('idle'),7000);
}
document.querySelectorAll('[data-gift]').forEach(b=>b.onclick=()=>react(b.dataset.gift));
function giftKind(value){
  const s=String(value).normalize('NFKC').toLowerCase();
  if(/universe|galaxy|ユニバース|ギャラクシー|インターステラー/.test(s))return'universe';
  if(/rocket|ロケット|ジェット/.test(s))return'rocket';
  if(/disco|mirror ball|ミラーボール|ディスコ/.test(s))return'disco';
  if(/money|マネー|札束/.test(s))return'money';
  if(/crown|王冠/.test(s))return'crown';
  if(/firework|花火/.test(s))return'fireworks';
  if(/confetti|紙吹雪/.test(s))return'confetti';
  if(/rose|rosa|バラ/.test(s))return'rose';
  return'heart';
}
async function playSpeech(token){try{ctx??=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();let response=await fetch(`/audio/last.wav?t=${encodeURIComponent(token)}`,{cache:'no-store'});if(!response.ok)return;let buffer=await ctx.decodeAudioData(await response.arrayBuffer());if(source){source.onended=null;try{source.stop()}catch{}}source=ctx.createBufferSource();source.buffer=buffer;analyser=ctx.createAnalyser();analyser.fftSize=1024;samples=new Uint8Array(analyser.fftSize);source.connect(analyser);analyser.connect(ctx.destination);source.onended=()=>{analyser=null;source=null};source.start()}catch(e){console.warn(e)}}
document.addEventListener("pointerdown",()=>ctx?.resume().catch(()=>{}));
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
  const level=stage.dataset.reaction==='idle'?mouth(now):0;
  if(stage.dataset.reaction!=='idle'){smoothMouth=0;lip.style.opacity='0';requestAnimationFrame(draw);return;}
  const target=level<0.015?0:0.1+Math.pow(level,0.65)*0.9;
  const response=target>smoothMouth?55:105;
  smoothMouth+=(target-smoothMouth)*(1-Math.exp(-elapsed/response));
  lip.style.opacity=String(clamp(smoothMouth,0,1));
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
function onState(s){if(!seenState){seenState=true;lastToken=s.audioToken||'';}let t=String(s.commentText||''),signature=`${s.commentAuthor}|${t}`;if(s.commentService==='TikTok'&&t.startsWith('ギフト「')&&signature!==lastGift){lastGift=signature;react(giftKind(t),s.commentAuthor||'視聴者')}speaking=!!s.isSpeaking;if(s.replyText&&speaking)document.getElementById('giftLine').textContent=s.replyText;if(s.audioToken&&s.audioToken!==lastToken){lastToken=s.audioToken;envelope=Array.isArray(s.mouthEnvelope)?s.mouthEnvelope:[];envelopeFrame=s.mouthFrameMs||40;envelopeStart=performance.now()+(s.lipSyncOffsetMs||0);if(s.browserAudio&&s.isSpeaking)playSpeech(s.audioToken)}}
if(new URLSearchParams(location.search).get('obs')==='1')document.body.classList.add('obs');try{let stream=new EventSource('/events');stream.onmessage=e=>onState(JSON.parse(e.data))}catch{}window.GiftLive={react,giftKind};
