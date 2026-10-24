const C='att-v3',L=[];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'].map(u=>c.add(u).catch(()=>{})).concat(L.map(u=>c.add(new Request(u,{mode:'no-cors'})).catch(()=>{})))).then(()=>self.skipWaiting())))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>clients.claim())));
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||(!r.url.startsWith(self.location.origin)&&!L.includes(r.url)))return;
 const store=res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res};
 if(r.mode==='navigate'){e.respondWith(fetch(r).then(store).catch(()=>caches.match('index.html')));return}
 e.respondWith(caches.match(r).then(h=>h||fetch(r).then(store)))});
