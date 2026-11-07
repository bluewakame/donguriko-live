const stage=document.getElementById('stage');
const idleVideo=document.getElementById('idleVideo');
const actionVideo=document.getElementById('actionVideo');
const particles=document.getElementById('particles');
const clips={welcome:'scene-welcome.mp4',wave:'scene-wave.mp4',heart:'scene-heart.mp4',celebrate:'scene-celebrate.mp4',speaking:'scene-speaking.mp4'};
const gifts={
  rose:['🌹','バラ、ありがとう！','バラにお礼中','🌹',24,'#ff8aa9','wave'],
  heart:['💗','ハート、受け取ったよ','ハートをお返し中','♥',30,'#ff79b2','heart'],
  confetti:['🎉','お祝いありがとう！','お祝い中','✦',54,'#ffe095','celebrate'],
  fireworks:['🎆','花火、すごい！','花火にリアクション中','✺',65,'#ffbb6f','celebrate'],
  crown:['👑','王冠、ありがとう！','キラキラお祝い中','✦',65,'#ffe09a','celebrate'],
  money:['💸','マネーガン！？ありがとう！','感謝が止まらない','💎',60,'#9dffcb','celebrate'],
  disco:['🪩','一緒に踊ろう！','ダンス気分','✦',55,'#8ce9ff','celebrate'],
  rocket:['🚀','ロケット発射！ありがとう！','宇宙へ出発中','✧',70,'#b7b5ff','celebrate'],
  universe:['🌌','ユニバース！？ありがとう！','スペシャルギフトに感謝中','✦',80,'#d9bdff','celebrate']
};
let activeScene='',actionFinished=false,speechActive=false,seenState=false,lastCommentId='',lastToken='',audioContext,audioSource,sceneTimeout;

function giftKind(value){
  const s=String(value).normalize('NFKC').toLowerCase();
  if(/universe|galaxy|ユニバース|ギャラクシー|インターステラー/.test(s))return'universe';
  if(/rocket|ロケット|ジェット/.test(s))return'rocket';
  if(/disco|ミラーボール|ディスコ/.test(s))return'disco';
  if(/money|マネー|札束/.test(s))return'money';
  if(/crown|王冠/.test(s))return'crown';
  if(/firework|花火/.test(s))return'fireworks';
  if(/confetti|紙吹雪/.test(s))return'confetti';
  if(/rose|rosa|バラ/.test(s))return'rose';
  return'heart';
}
function showScene(scene){
  clearTimeout(sceneTimeout);
  activeScene=scene;
  actionFinished=false;
  const file=clips[scene];
  if(!file)return;
  const begin=()=>{
    if(activeScene!==scene)return;
    actionVideo.loop=scene==='speaking';
    actionVideo.currentTime=0;
    actionVideo.play().catch(()=>{});
    stage.classList.add('scene-active');
  };
  if(actionVideo.dataset.file!==file){
    actionVideo.dataset.file=file;
    actionVideo.src=file;
    actionVideo.load();
    actionVideo.addEventListener('loadeddata',begin,{once:true});
  }else if(actionVideo.readyState>=2)begin();
  else actionVideo.addEventListener('loadeddata',begin,{once:true});
}
function clearScene(){
  activeScene='';
  actionFinished=false;
  stage.classList.remove('scene-active');
  stage.dataset.reaction='idle';
  particles.replaceChildren();
  document.getElementById('modeLabel').textContent='ゆったり配信中';
  setTimeout(()=>{if(!activeScene)actionVideo.pause()},450);
}
function returnAfterAction(){
  if(activeScene==='speaking')return;
  if(speechActive)return;
  clearScene();
}
actionVideo.addEventListener('ended',()=>{actionFinished=true;returnAfterAction()});
function addParticles(symbol,count,color){
  particles.replaceChildren();
  for(let i=0;i<count;i++){
    const p=document.createElement('span');p.className='particle';p.textContent=symbol;
    p.style.setProperty('--x',Math.random()*100+'%');
    p.style.setProperty('--s',12+Math.random()*20+'px');
    p.style.setProperty('--d',2+Math.random()*2.5+'s');
    p.style.setProperty('--delay',Math.random()*.8+'s');
    p.style.setProperty('--c',color);particles.append(p);
  }
}
function showEvent(kind,author=''){
  let icon,title,mode,symbol,count,color,scene;
  if(kind==='welcome'){
    [icon,title,mode,symbol,count,color,scene]=['👋',author?author+'さん、いらっしゃい！':'いらっしゃい！','新しい視聴者を歓迎中','✦',20,'#ffddaa','welcome'];
  }else if(kind==='follow'){
    [icon,title,mode,symbol,count,color,scene]=['💗',author?author+'さん、フォローありがとう！':'フォローありがとう！','フォローに感謝中','♥',25,'#ff99c3','wave'];
  }else{
    [icon,title,mode,symbol,count,color,scene]=gifts[kind]||gifts.heart;
  }
  stage.dataset.reaction=kind;
  document.getElementById('giftIcon').textContent=icon;
  document.getElementById('giftTitle').textContent=title;
  document.getElementById('giftFrom').textContent=author?author+' さん':'WELCOME';
  document.getElementById('modeLabel').textContent=mode;
  addParticles(symbol,count,color);
  showScene(scene);
  // SSE が途切れても映像を固定したままにしない。
  sceneTimeout=setTimeout(()=>{speechActive=false;clearScene()},15000);
}
async function playSpeech(token){
  try{
    audioContext??=new (window.AudioContext||window.webkitAudioContext)();
    await audioContext.resume();
    const response=await fetch('/audio/last.wav?t='+encodeURIComponent(token),{cache:'no-store'});
    if(!response.ok)return;
    const buffer=await audioContext.decodeAudioData(await response.arrayBuffer());
    if(audioSource){audioSource.onended=null;try{audioSource.stop()}catch{}}
    audioSource=audioContext.createBufferSource();audioSource.buffer=buffer;
    audioSource.connect(audioContext.destination);
    audioSource.onended=()=>{audioSource=null};
    audioSource.start();
  }catch(error){console.warn(error)}
}
document.addEventListener('pointerdown',()=>audioContext?.resume().catch(()=>{}));
function onState(s){
  const currentId=String(s.commentId||'');
  const newEvent=currentId&&currentId!==lastCommentId&&
    (seenState||s.isSpeaking||s.status==='thinking');
  if(!seenState){seenState=true;lastToken=s.audioToken||''}
  if(currentId)lastCommentId=currentId;
  speechActive=!!s.isSpeaking;
  if(newEvent&&s.commentService==='TikTok'){
    const text=String(s.commentText||'');
    if(s.commentKind==='viewer-enter')showEvent('welcome',s.commentAuthor||'視聴者');
    else if(text.startsWith('ギフト「'))showEvent(giftKind(text),s.commentAuthor||'視聴者');
    else if(text==='フォローしたよ')showEvent('follow',s.commentAuthor||'視聴者');
  }
  if(s.replyText&&s.isSpeaking)document.getElementById('giftLine').textContent=s.replyText;
  if(s.isSpeaking){
    if(!activeScene)showScene('speaking');
  }else if(activeScene==='speaking'||(activeScene&&actionFinished))clearScene();
  if(s.audioToken&&s.audioToken!==lastToken){
    lastToken=s.audioToken;
    if(s.browserAudio&&s.isSpeaking)playSpeech(s.audioToken);
  }
}
function keepIdlePlaying(){if(idleVideo.paused||idleVideo.ended)idleVideo.play().catch(()=>{})}
idleVideo.addEventListener('pause',()=>setTimeout(keepIdlePlaying,250));
setInterval(keepIdlePlaying,2000);keepIdlePlaying();
document.querySelectorAll('[data-preview]').forEach(button=>button.onclick=()=>{
  const kind=button.dataset.preview;
  if(kind==='idle'){speechActive=false;clearScene()}
  else if(kind==='speaking')showScene('speaking');
  else showEvent(kind);
});
if(new URLSearchParams(location.search).get('obs')==='1')document.body.classList.add('obs');
if(!new URLSearchParams(location.search).has('demo')){
  const stream=new EventSource('/events');
  stream.onmessage=event=>{try{onState(JSON.parse(event.data))}catch(error){console.warn(error)}};
}
window.GiftLive={showEvent,giftKind};
