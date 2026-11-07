import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { Relay } from '../src/relay.mjs';
import { Telegram } from '../src/telegram.mjs';
import { Gateway, HarnessAdapter } from '../src/gateway.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t, { path = ':memory:' } = {}) {
  const calls=[]; let mid=100,topic=500,update=0,failSend=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req) raw+=chunk;
    const payload=JSON.parse(raw),method=req.url.split('/').at(-1);calls.push({method,payload});
    if(method==='sendMessage' && failSend) {failSend=false;res.statusCode=500;res.end(JSON.stringify({ok:false,error_code:500,description:'simulated unknown send'}));return;}
    const result=method==='getMe'?{has_topics_enabled:true}:method==='getWebhookInfo'?{url:''}
      :method==='createForumTopic'?{message_thread_id:++topic}:method==='sendMessage'?{message_id:++mid}
      :method==='editMessageText'?{message_id:payload.message_id}:true;
    res.end(JSON.stringify({ok:true,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  let store=new Store(path);t.after(()=>store.close());
  const telegram=new Telegram({token:'FAKE',baseUrl:`http://127.0.0.1:${server.address().port}`});
  const makeRelay=()=>new Relay({store,telegram,ownerId:42,gatewayIds:['local','server'],logger:{warn(){}}});
  let relay=makeRelay();
  const state=()=>store.entries('creation:request:').at(-1)?.[1];
  const message=async(text,patch={},deliver=true)=>{
    const content=text===undefined?{message_thread_id:7,forum_topic_created:{name:'Новая тема'}}:{text};
    relay.ingest([{update_id:++update,message:{message_id:update,from:{id:42},chat:{id:42,type:'private'},...content,...patch}}]);
    await relay.receive();if(deliver) await relay.deliver();
  };
  const click=async(device='local',patch={})=>{
    const s=state();relay.ingest([{update_id:++update,callback_query:{id:`cb${update}`,from:{id:42},data:`nc:${s.token}:${device}`,
      message:{message_id:s.messageId,chat:{id:42,type:'private'},message_thread_id:s.topic},...patch}}]);
    await relay.receive();await relay.deliver();
  };
  const exchange=(gateway,revision,extra={})=>relay.exchange(gateway,{revision,sessions:[],...extra});
  return {get store(){return store;},get relay(){return relay;},calls,state,message,click,exchange,
    failSend:()=>{failSend=true;},restart:()=>{store.close();store=new Store(path);relay=makeRelay();}};
}

test('button flow creates exactly one pinned command, waits for capable Host, and binds its real topic',async t=>{
  const f=await fixture(t);await f.relay.verifyBot();await f.relay.deliver();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,0,'startup must not publish a spare menu');
  await f.message();const initial=f.state();
  const card=f.calls.filter(c=>c.method==='sendMessage').at(-1).payload;
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map(b=>b.text),['Mac','VPS']);
  for(const b of card.reply_markup.inline_keyboard[0]) assert.ok(Buffer.byteLength(b.callback_data)<=64);
  await f.click('local');await f.click('server');
  assert.equal(f.store.pending('gateway:local').length,1);
  assert.equal(f.store.pending('gateway:server').length,0);
  assert.equal(f.exchange('server',1,{capabilities:['session-create-v1']}).commands.length,0);
  assert.equal(f.exchange('local',1).commands.length,0,'old Host must not receive unsupported creation');
  const [command]=f.exchange('local',2,{capabilities:['session-create-v1']}).commands;
  assert.equal(command.kind,'session-create');assert.match(command.sessionId,/^session-/);
  assert.equal(command.token,initial.token);
  f.exchange('local',3,{capabilities:['session-create-v1'],sessions:[{sessionId:command.sessionId,title:'Новый диалог',archived:false,running:false}],
    acknowledgements:[{id:command.id,status:'done'}]});
  await f.relay.deliver();
  const ready=f.state();assert.equal(ready.status,'ready');assert.ok(ready.boundTopic);
  assert.equal(f.calls.filter(c=>c.method==='createForumTopic').length,0);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1,'only the original selector is sent');
  const confirmation=f.calls.filter(c=>c.method==='editMessageText').at(-1).payload;
  assert.equal(confirmation.text,'Подключено к Mac.');
  assert.deepEqual(confirmation.reply_markup,{inline_keyboard:[]});
  f.store.enqueue('old-welcome','telegram',{op:'navigation',action:'welcome',key:ready.key,token:ready.token});
  await f.relay.deliver();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1,'old queued welcome cannot add a duplicate');
  const edits=f.calls.filter(c=>c.method==='editMessageText').length;
  await f.relay.verifyBot();await f.relay.deliver();
  assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,edits,'restart preflight leaves existing history unchanged');
  await f.message('Первая задача',{message_thread_id:ready.boundTopic});
  const input=f.store.pending('gateway:local').find(j=>j.payload.kind!=='session-create');
  assert.equal(input.payload.sessionId,command.sessionId);
  assert.equal(f.store.pending('gateway:server').length,0);
});

test('user-created topic is bound in place and first messages survive until durable Host ACK',async t=>{
  const f=await fixture(t);
  await f.message('',{message_thread_id:77,forum_topic_created:{name:'Моя задача'}});
  await f.message('Первое сообщение',{message_thread_id:77});
  await f.click('server');
  await f.message('Ещё сообщение до подключения',{message_thread_id:77});
  assert.equal(f.store.entries('creation:request:').length,1);
  assert.equal(f.store.db.prepare("select count(*) as n from jobs where lane='incoming' and status='held'").get().n,2);
  const [command]=f.exchange('server',1,{capabilities:['session-create-v1']}).commands;
  assert.equal(command.title,'Моя задача');
  const sessions=[{sessionId:command.sessionId,title:'Моя задача',archived:false,running:false}];
  f.exchange('server',2,{sessions,capabilities:['session-create-v1']});
  await f.relay.deliver();
  assert.equal(f.calls.filter(c=>c.method==='createForumTopic').length,0,'never create a second topic while waiting for ACK');
  assert.equal(f.state().status,'queued');
  f.exchange('server',3,{sessions,capabilities:['session-create-v1'],acknowledgements:[{id:command.id,status:'done'}]});
  await f.relay.deliver();await f.relay.receive();
  assert.equal(f.state().status,'ready');assert.equal(f.state().boundTopic,77);
  assert.equal(f.calls.filter(c=>c.method==='createForumTopic').length,0);
  assert.equal(f.calls.filter(c=>c.method==='editForumTopic').length,0,'keep user topic title without brackets');
  assert.deepEqual(f.store.pending('gateway:server').filter(j=>!j.payload.kind).map(j=>j.payload.content[0].text),
    ['Первое сообщение','Ещё сообщение до подключения']);
  assert.equal(f.store.pending('gateway:local').length,0);
});

test('held first input and existing-topic reservation survive a relay restart',async t=>{
  const path=join(mkdtempSync(join(tmpdir(),'dsh-inplace-')),'state.sqlite');
  const f=await fixture(t,{path});await f.message('Не терять эту задачу',{message_thread_id:88});
  await f.click('local');const request=f.state();f.restart();
  const sessions=[{sessionId:request.sessionId,title:'Новый диалог',archived:false,running:false}];
  const [command]=f.exchange('local',1,{capabilities:['session-create-v1']}).commands;
  f.exchange('local',2,{sessions,capabilities:['session-create-v1'],acknowledgements:[{id:command.id,status:'done'}]});
  await f.relay.deliver();await f.relay.receive();
  assert.equal(f.state().boundTopic,88);
  assert.equal(f.calls.filter(c=>c.method==='createForumTopic').length,0);
  assert.equal(f.store.pending('gateway:local').filter(j=>!j.payload.kind)[0].payload.content[0].text,'Не терять эту задачу');
});

test('legacy true update marker replays as done, never an invalid SQLite status',async t=>{
  const f=await fixture(t);f.store.set('creation:update:1',true);await f.message();
  assert.equal(f.store.job('update:1').status,'done');assert.equal(f.state(),undefined);
});

test('first text in an unbound Telegram topic also opens the machine selector and is held',async t=>{
  const f=await fixture(t);await f.message('Задача с телефона',{message_thread_id:81});
  assert.equal(f.state().existingTopic,81);assert.equal(f.state().status,'choosing');
  assert.equal(f.store.job(f.state().heldIds[0]).status,'held');
});

test('historical new-dialog button and old commands show instructions without creating another dialogue',async t=>{
  const f=await fixture(t);await f.message();await f.click('local');
  await f.click('local',{data:'nc:new'});
  for(const text of ['Новый диалог','/new','/start']) await f.message(text);
  assert.equal(f.store.entries('creation:request:').length,1);
  assert.equal(f.store.pending('gateway:local').length,1);
  const screens=f.calls.filter(c=>c.method==='sendMessage').slice(1);
  assert.ok(screens.length);
  for(const screen of screens) {
    assert.match(screen.payload.text,/Создай новую тему Telegram/);
    assert.deepEqual(screen.payload.reply_markup,{inline_keyboard:[]});
  }
});

test('forged owner, group, bot, wrong message, wrong topic and expired callback cannot create',async t=>{
  const f=await fixture(t);
  await f.message('Новый диалог',{from:{id:43}});assert.equal(f.state(),undefined);
  await f.message();const s=f.state();
  for(const patch of [
    {from:{id:43}}, {from:{id:42,is_bot:true}},
    {message:{message_id:s.messageId,chat:{id:42,type:'group'},message_thread_id:s.topic}},
    {message:{message_id:s.messageId+1,chat:{id:42,type:'private'},message_thread_id:s.topic}},
    {message:{message_id:s.messageId,chat:{id:42,type:'private'},message_thread_id:s.topic+1}},
    {data:`nc:${s.token}:evil`},
  ]) await f.click('local',patch);
  assert.equal(f.store.pending('gateway:local').length,0);
  assert.equal(f.store.pending('gateway:server').length,0);
  f.relay.now=()=>s.expiresAt+1;await f.click();
  assert.equal(f.store.pending('gateway:local').length,0);
});

test('repeated menu presses reuse a known selection instead of accumulating screens',async t=>{
  const f=await fixture(t);await f.message();await f.message();
  assert.equal(f.store.entries('creation:request:').length,1);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(f.calls.filter(c=>c.method==='editMessageText').length,1);
});

test('disk restart recovers saved card receipt and preserves an offline pinned creation command',async t=>{
  const path=join(mkdtempSync(join(tmpdir(),'dsh-create-')),'state.sqlite');
  const f=await fixture(t,{path});await f.message();const initial=f.state();
  f.store.set(`creation:request:${initial.token}`,{...initial,messageId:null});
  f.store.status(initial.selectorJobId,'sending');f.restart();
  await f.message();assert.equal(f.state().messageId,initial.messageId);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  await f.click('server');f.restart();await f.click('local');
  assert.equal(f.store.pending('gateway:server').length,1);
  assert.equal(f.store.pending('gateway:local').length,0);
  assert.equal(f.exchange('local',1,{capabilities:['session-create-v1']}).commands.length,0);
});

test('unknown card send is not repeated by another queued refresh',async t=>{
  const f=await fixture(t);f.failSend();
  await f.message(undefined,{},false);await f.message(undefined,{},false);
  await f.relay.deliver();
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(f.store.pending('gateway:local').length,0);
  const oldToken=f.state().token;
  await f.message();
  assert.equal(f.store.entries('creation:request:').length,2);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,2);
  assert.ok(f.store.entries('creation:request:').some(([,s])=>s.token!==oldToken && s.messageId));
});

test('callback ACK failure does not lose or duplicate the durable request',async t=>{
  const f=await fixture(t);await f.message();
  const call=f.relay.telegram.call.bind(f.relay.telegram);
  f.relay.telegram.call=async(method,...args)=>{if(method==='answerCallbackQuery') throw new Error('ACK unavailable');return call(method,...args);};
  await f.click();await f.click();
  assert.equal(f.store.pending('gateway:local').length,1);
});

function host(t,{flush=true,minted=false,commitThenThrow=false}={}) {
  const store=new Store();t.after(()=>store.close());
  const records=[],sessions=new Map(),calls=[];let title;
  const ctx={workingDirectory:{defaultDirectory:'/host-work'},workspaceRegistry:{archivedSessionIds:[]},agents:{get:()=>null},
    connection:{createPeer:()=>({dispose(){}})},sessionQuery:{listSessions:async()=>records},
    sessions:{get:id=>sessions.get(id),flush:async session=>{calls.push(['flush',session.id]);return flush;}},
    typertGateway:{invoke:async({method,args})=>{
      const r=args.request;calls.push([method,r]);
      if(method==='create') {
        assert.ok(store.entries('create:').some(([,phase])=>phase.sessionId===r.sessionId && phase.status==='creating'));
        const id=minted?'session-other':r.sessionId;
        records.push({header:{id,cwd:r.cwd}});sessions.set(id,{id});
        if(commitThenThrow) throw new Error('simulated lost response');
        return {sessionId:id};
      }
      if(method==='list') return {items:records.map(({header})=>({sessionId:header.id,projections:{values:{title}}}))};
      if(method==='rename') {title=r.title;return {title,seq:1};}
      if(method==='events') return {cursor:1,hasMore:false,records:[{type:'event',event:{seq:1,type:'session/title',data:{title}}}]};
      if(method==='state') {sessions.set(r.sessionId,{id:r.sessionId});return {};}
      throw new Error('Unexpected method '+method);
    }}};
  const adapter=new HarnessAdapter(ctx);
  const command={id:'command',kind:'session-create',sessionId:'session-test',title:'Новый диалог'};
  return {store,records,sessions,calls,ctx,adapter,command};
}

test('actual menu → command → Host API → durable ACK → inventory → topic flow on VPS',async t=>{
  const f=await fixture(t);await f.message();await f.click('server');
  const h=host(t);
  const gateway=new Gateway({store:h.store,adapter:h.adapter,logger:{warn(){}},
    client:{exchange:async payload=>f.relay.exchange('server',payload)}});
  await gateway.tick();
  assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='flush').length,1);
  await gateway.tick();await f.relay.deliver();
  assert.equal(f.state().status,'ready');assert.equal(f.state().gatewayId,'server');
  assert.ok(f.relay.session(f.state().key).topic);
  assert.equal(f.store.pending('gateway:local').length,0);
  assert.equal(h.calls.filter(c=>c[0]==='prompt'||c[0]==='selectModel').length,0);
});

test('filesystem root is not silently granted as a new conversation workspace',async t=>{
  const h=host(t);h.ctx.workingDirectory.defaultDirectory='/';
  await assert.rejects(()=>h.adapter.createSession(h.command,h.store),/defaultDirectory/);
  assert.equal(h.calls.length,0);
});

test('Host creation uses its own cwd/default model and acknowledges only after durable flush',async t=>{
  const h=host(t);await h.adapter.createSession(h.command,h.store);await h.adapter.createSession(h.command,h.store);
  assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
  assert.equal(h.calls.find(c=>c[0]==='create')[1].cwd,'/host-work');
  assert.equal(h.calls.filter(c=>c[0]==='rename').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='selectModel'||c[0]==='prompt').length,0);
  assert.equal(h.calls.at(-1)[0],'flush');
  assert.equal(h.store.get('create:command').status,'done');
});

test('recovery reconciles a committed named session without repeating native create',async t=>{
  const h=host(t,{commitThenThrow:true});
  await assert.rejects(()=>h.adapter.createSession(h.command,h.store),e=>e.creationUncertain===true);
  await h.adapter.createSession(h.command,h.store);
  assert.equal(h.calls.filter(c=>c[0]==='create').length,1);
  assert.equal(h.store.get('create:command').status,'done');
});

test('directory repair is restricted to an unused bridge-created session and preserves user changes',async t=>{
  const h=host(t);await h.adapter.createSession(h.command,h.store);
  let current='/host-work',sets=0;
  h.adapter.newSessionCwd='/safe-work';
  h.ctx.sessionController={resolveAgent:async id=>({agent:{session:h.sessions.get(id),status:'idle'}})};
  h.ctx.workingDirectory.get=()=>current;
  h.ctx.workingDirectory.set=async(_agent,cwd)=>{sets++;current=cwd;};
  const command={id:'repair',creationId:'command',sessionId:'session-test',expectedOldCwd:'/host-work'};
  await h.adapter.repairCreationCwd(command,h.store);await h.adapter.repairCreationCwd(command,h.store);
  assert.equal(current,'/safe-work');assert.equal(sets,1);
  assert.equal(h.store.get('cwd-repair:repair').status,'done');
  current='/user-selected';
  await h.adapter.repairCreationCwd({...command,id:'preserve'},h.store);
  assert.equal(current,'/user-selected');assert.equal(sets,1);
  await assert.rejects(()=>h.adapter.repairCreationCwd({...command,id:'wrong',creationId:'unknown'},h.store),/not authorized/);
});

test('directory repair refuses a conversation that already ran a turn',async t=>{
  const h=host(t);await h.adapter.createSession(h.command,h.store);h.adapter.newSessionCwd='/safe-work';
  h.ctx.sessionController={resolveAgent:async id=>({agent:{session:h.sessions.get(id),status:'idle'}})};
  h.ctx.workingDirectory.get=()=>'/host-work';h.ctx.workingDirectory.set=()=>assert.fail('must not relocate used Session');
  h.adapter.page=async()=>({cursor:2,hasMore:false,records:[{type:'event',event:{seq:2,type:'turn/start'}}]});
  await assert.rejects(()=>h.adapter.repairCreationCwd({id:'repair',creationId:'command',sessionId:'session-test',expectedOldCwd:'/host-work'},h.store),/used conversation/);
});

test('missing uncertain identity, minted ID and absent durability never report success or retry create',async t=>{
  const collision=host(t);collision.records.push({header:{id:'session-test',cwd:'/host-work'}});
  await assert.rejects(()=>collision.adapter.createSession(collision.command,collision.store),e=>e.creationUncertain===true);
  assert.equal(collision.calls.length,0);
  const unknown=host(t);unknown.store.set('create:command',{status:'creating',sessionId:'session-test',cwd:'/host-work',title:'Новый диалог'});
  await assert.rejects(()=>unknown.adapter.createSession(unknown.command,unknown.store),e=>e.creationUncertain===true);
  assert.equal(unknown.calls.length,0);
  const minted=host(t,{minted:true});await assert.rejects(()=>minted.adapter.createSession(minted.command,minted.store),e=>e.creationUncertain===true);
  assert.notEqual(minted.store.get('create:command').status,'done');
  const volatile=host(t,{flush:false});await assert.rejects(()=>volatile.adapter.createSession(volatile.command,volatile.store),e=>e.creationUncertain===true);
  assert.notEqual(volatile.store.get('create:command').status,'done');
});
