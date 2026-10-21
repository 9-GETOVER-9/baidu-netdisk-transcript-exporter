// A closed local network: CONNECT can only tunnel to our loopback fixture server.
// No request is forwarded to Baidu or any other Internet server.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

async function startNetwork(temp, respond) {
  const key = path.join(temp,'fixture-key.pem'), cert = path.join(temp,'fixture-cert.pem');
  const config = path.join(temp,'openssl.cnf');
  fs.writeFileSync(config,'[req]\ndistinguished_name=dn\n[dn]\n');
  const args = ['req','-config',config,'-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=pan.baidu.com'];
  let result = spawnSync(process.env.OPENSSL || 'openssl',args,{encoding:'utf8'});
  if (result.error?.code === 'ENOENT' && process.platform === 'win32') {
    const git = spawnSync('git',['--exec-path'],{encoding:'utf8'});
    if (git.status === 0) result = spawnSync(path.resolve(git.stdout.trim(),'../../../usr/bin/openssl.exe'),args,{encoding:'utf8'});
  }
  if (result.status !== 0) throw Error('Test certificates require OpenSSL (or OPENSSL path): '+(result.error?.message || result.stderr));
  const sockets = new Set(), requests = [], blocked = [];
  function track(socket) { sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{}); }
  const site = https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
    if (req.headers.host !== 'pan.baidu.com') { res.writeHead(403);res.end();return; }
    const u = new URL(req.url,'https://pan.baidu.com');requests.push(u.pathname);
    const reply = respond(u);
    res.writeHead(reply.status || 200, {'Content-Type':reply.json?'application/json; charset=utf-8':(reply.contentType || 'text/plain')+'; charset=utf-8','Cache-Control':'no-store'});
    res.end(reply.json?JSON.stringify(reply.json):reply.body);
  });
  site.on('connection',track);
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const proxy = http.createServer((req,res)=>{blocked.push(req.url);res.writeHead(403);res.end();});
  proxy.on('connection',track);
  proxy.on('connect',(req,client,head)=>{
    if (req.url !== 'pan.baidu.com:443') {blocked.push(req.url);client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    const upstream=net.connect(site.address().port,'127.0.0.1',()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)upstream.write(head);
      client.pipe(upstream);upstream.pipe(client);
    });
    track(upstream);client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${proxy.address().port}`,requests,blocked,async close(){
    for(const socket of sockets)socket.destroy();
    await Promise.all([site,proxy].map(server=>new Promise(resolve=>server.close(resolve))));
  }};
}
module.exports={startNetwork};
