import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const {port}=server.address();await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;}
function dateOffset(days){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));const today=new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);today.setUTCDate(today.getUTCDate()+days);return today.toISOString().slice(0,10);}

test('products, expiry alerts, POS validation and final prices stay consistent',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.products-expiry-test-')),serverDir=join(runtime,'server');await mkdir(serverDir,{recursive:true});await mkdir(join(runtime,'data'),{recursive:true});await copyFile(resolve('server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`,child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port)},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,2000))]);}await rm(runtime,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}assert.equal(ready,true,'isolated API did not start');
  const setupResponse=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@kiosco.local',password:'temporary-test-password'})});assert.equal(setupResponse.status,201);const authCookie=setupResponse.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',body)=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','Cookie':authCookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()}};
  const bootstrap=(await request('/bootstrap')).data,category=bootstrap.categories[0],supplier=bootstrap.suppliers[0];assert.equal(bootstrap.expiry_alert_days,30);
  const create=payload=>request('/products','POST',{name:'Test item',sku:`TEST-${Math.random().toString(16).slice(2,10)}`,category_id:category.id,supplier_id:supplier.id,cost:4,price:12.34,tax_rate:21,tax_included:1,stock:5,stock_alert:1,...payload});
  const noDate=await create({sku:'EXP-NONE'});assert.equal(noDate.status,201);assert.equal((await request('/products')).data.find(p=>p.id===noDate.data.id).expiry_status,'none');
  assert.equal((await create({sku:'EXP-BAD-CATEGORY',category_id:'missing'})).status,400);
  assert.equal((await create({sku:'EXP-BAD-SUPPLIER',supplier_id:'missing'})).status,400);
  assert.equal((await create({sku:'EXP-BAD-PRICE',price:-1})).status,400);
  assert.equal((await create({sku:'EXP-BAD-COST',cost:'NaN'})).status,400);
  assert.equal((await create({sku:'EXP-BAD-TAX',tax_rate:101})).status,400);
  assert.equal((await create({sku:'EXP-BAD-DATE',expires_on:'2026-02-30'})).status,400);
  assert.equal((await create({sku:'EXP-NONE'})).status,409,'product SKU is unique without regard to case');
  const editable=(await create({sku:'EXP-EDIT',price:10})).data;
  const edited=await request(`/products/${editable.id}`,'PATCH',{price:12.34,cost:5,stock_alert:2,active:0});assert.equal(edited.status,200);
  const saleBody=(id,amount,extras={})=>({items:[{id,quantity:1,price:0}],payments:[{method:'qr',amount}],...extras});
  assert.equal((await request('/sales','POST',saleBody(editable.id,12.34))).status,400,'inactive product must not sell');assert.equal((await request(`/scan/${editable.sku}`)).status,404,'inactive product is hidden from barcode scan');
  assert.equal((await request(`/products/${editable.id}`,'PATCH',{active:1})).status,200);assert.equal((await request(`/scan/${editable.sku}`)).status,200,'active product resolves in barcode scan');
  const sold=await request('/sales','POST',saleBody(editable.id,12.34));assert.equal(sold.status,201);assert.equal(sold.data.total,12.34);assert.equal(sold.data.items[0].unit_price,12.34);
  assert.equal((await request(`/products/${editable.id}`,'PATCH',{price:20})).status,200);
  const historicDetail=await request(`/sales/${sold.data.id}`);assert.equal(historicDetail.data.total,12.34);assert.equal(historicDetail.data.items[0].unit_price,12.34);
  const afterSale=(await request('/products')).data.find(p=>p.id===editable.id);assert.equal(afterSale.stock,4);
  assert.equal((await request('/sales','POST',saleBody(editable.id,20,{items:[{id:editable.id,quantity:5}],payments:[{method:'qr',amount:100}]}))).status,409,'insufficient stock must reject');
  const expired=(await create({sku:'EXP-PAST',expires_on:dateOffset(-1)})).data;
  assert.equal((await request('/products')).data.find(p=>p.id===expired.id).expiry_status,'expired');
  assert.equal((await request('/sales','POST',saleBody(expired.id,12.34))).status,409,'expired product is blocked in POS');assert.equal((await request(`/scan/${expired.sku}`)).status,409,'expired product cannot be added by barcode scan');
  const near=(await create({sku:'EXP-NEAR',expires_on:dateOffset(30)})).data;
  assert.equal((await request('/products')).data.find(p=>p.id===near.id).expiry_status,'expiring');
  assert.equal((await request('/sales','POST',saleBody(near.id,12.34))).status,201,'near-expiry product remains sellable');
  const later=(await create({sku:'EXP-LATER',expires_on:dateOffset(31)})).data;
  assert.equal((await request('/products')).data.find(p=>p.id===later.id).expiry_status,'ok');
  const zero=(await create({sku:'EXP-ZERO',stock:0,expires_on:dateOffset(-1)})).data;
  assert.equal((await request('/products')).data.find(p=>p.id===zero.id).expiry_status,'none','no stock means no expiry alert');assert.equal((await request('/sales','POST',saleBody(zero.id,12.34))).status,409,'zero stock cannot be sold');
  const inherited=(await create({sku:'EXP-INHERITED',expires_on:dateOffset(20)})).data;assert.equal((await request(`/products/${inherited.id}`,'PATCH',{variants:[{name:'Tamaño A',sku:'EXP-INHERITED-A',stock:5}]})).status,200);const inheritedListed=(await request('/products')).data.find(p=>p.id===inherited.id);assert.equal(inheritedListed.expires_on,null);assert.equal(inheritedListed.variants[0].expires_on,dateOffset(20));
  const variantResult=await create({sku:'EXP-VARIANTS',stock:0,variants:[{name:'Vencida',sku:'EXP-VAR-OLD',stock:2,expires_on:dateOffset(-1)},{name:'Vigente',sku:'EXP-VAR-NEW',stock:3,expires_on:dateOffset(15)}]});assert.equal(variantResult.status,201,JSON.stringify(variantResult.data));const variant=variantResult.data;
  const productsNow=(await request('/products')).data;const enriched=productsNow.find(p=>p.id===variant.id);assert.ok(enriched,JSON.stringify({variant,productsNow}));assert.equal(enriched.stock,5);assert.equal(enriched.expiry_status,'expired');assert.equal(enriched.variants.find(v=>v.name==='Vencida').expiry_status,'expired');
  assert.equal((await request('/sales','POST',saleBody(variant.id,12.34))).status,400,'variant selection is required');
  assert.equal((await request('/sales','POST',{items:[{id:variant.id,variant_id:enriched.variants.find(v=>v.name==='Vencida').id,quantity:1}],payments:[{method:'qr',amount:12.34}]})).status,409,'expired variant is blocked');
  assert.equal((await request('/sales','POST',{items:[{id:variant.id,variant_id:enriched.variants.find(v=>v.name==='Vigente').id,quantity:1}],payments:[{method:'qr',amount:12.34}]})).status,201);
  const before=(await request('/products')).data.find(p=>p.id===variant.id);assert.equal(before.stock,4);
  assert.equal((await request(`/products/${variant.id}`,'PATCH',{variants:[{...before.variants[0],stock:2},{...before.variants[1],stock:3}]})).status,200,'variant stock and expiration edits remain valid');
  const db=new DatabaseSync(join(runtime,'data','kiosco.sqlite'));
  const soldRows=db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;assert.equal(soldRows,3);
  const salePayments=db.prepare('SELECT SUM(amount) AS n FROM payments WHERE sale_id=?').get(sold.data.id).n;assert.equal(salePayments,12.34);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_movements').get().n,0,'QR-only tests do not create cash movements');
  const variantCols=db.prepare('PRAGMA table_info(product_variants)').all().map(row=>row.name);assert.ok(variantCols.includes('expires_on'));db.close();
});


