import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort(){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const {port}=server.address();await new Promise(done=>server.close(done));return port;
}

test('audit regressions: exact-cent payments, unit quantities, malformed bodies and concurrent stock protection',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.audit-test-')),serverDir=join(runtime,'server'),dataDir=join(runtime,'data');
  await mkdir(serverDir,{recursive:true});await mkdir(dataDir,{recursive:true});
  const dbPath=join(dataDir,'kiosco.sqlite');await copyFile(join(process.cwd(),'server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`,child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port),KIOSCO_DB_PATH:dbPath},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,1500))]);}await rm(runtime,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}assert.equal(ready,true,'isolated API did not start');
  const request=async(path,method='GET',body,cookie='')=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
  const setup=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Admin',email:'admin@kiosco.local',password:'administrator-password'})});
  assert.equal(setup.status,201);const admin=setup.headers.get('set-cookie').split(';')[0];
  const category=(await request('/bootstrap','GET',undefined,admin)).data.categories[0];
  const badNull=await request('/products','POST',null,admin);assert.equal(badNull.status,400);assert.match(badNull.data.error,/JSON inválido/);
  const malformed=await fetch(`${base}/sales`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:admin},body:'{'});assert.equal(malformed.status,400);assert.doesNotMatch((await malformed.json()).error,/SyntaxError|SQLite|JSON at position/);
  assert.equal((await request('/cash/open','POST',{amount:0.001},admin)).status,400,'cash amounts are limited to cents');
  assert.equal((await request('/cash/open','POST',{amount:0},admin)).status,201);
  const product=(await request('/products','POST',{name:'Unidad de prueba',sku:'AUD-UNIT',category_id:category.id,stock:3,cost:0.25,price:1},admin)).data;
  const underpaid=await request('/sales','POST',{items:[{id:product.id,quantity:1}],payments:[{method:'efectivo',amount:0.99}]},admin);
  assert.equal(underpaid.status,400,'one-cent underpayment must be rejected');
  assert.match(underpaid.data.error,/último centavo/);
  const fractional=await request('/sales','POST',{items:[{id:product.id,quantity:1.5}],payments:[{method:'efectivo',amount:1.5}]},admin);
  assert.equal(fractional.status,400,'unit products cannot be sold fractionally');
  const invalidPurchase=await request('/purchases','POST',{product_id:product.id,quantity:1.5,unit_cost:0.25},admin);
  assert.equal(invalidPurchase.status,400,'unit products cannot be received fractionally');
  let db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM purchases').get().n,0);assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,3);assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,0);db.close();
  const paid=await request('/sales','POST',{items:[{id:product.id,quantity:1}],payments:[{method:'efectivo',amount:1}]},admin);assert.equal(paid.status,201);
  db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT line_total FROM sale_items WHERE sale_id=?').get(paid.data.id).line_total,1);db.close();
  const kg=(await request('/products','POST',{name:'Producto por peso',sku:'AUD-KG',unit:'kg',category_id:category.id,stock:1,cost:1.25,price:100},admin)).data;
  const fractionalPurchase=await request('/purchases','POST',{product_id:kg.id,quantity:0.25,unit_cost:20},admin);assert.equal(fractionalPurchase.status,201,'fractional weight purchases remain supported');
  const fractionalSale=await request('/sales','POST',{items:[{id:kg.id,quantity:0.25}],payments:[{method:'tarjeta',amount:25}]},admin);assert.equal(fractionalSale.status,201,'fractional weight sales remain supported');
  const concurrent=(await request('/products','POST',{name:'Stock concurrente',sku:'AUD-RACE',category_id:category.id,stock:1,cost:0.25,price:2},admin)).data;
  const responses=await Promise.all([1,2].map(()=>request('/sales','POST',{items:[{id:concurrent.id,quantity:1}],payments:[{method:'qr',amount:2}]},admin)));
  assert.deepEqual(responses.map(result=>result.status).sort(),[201,409]);
  db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(concurrent.id).stock,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM sales WHERE total=2').get().n,1);db.close();
});
