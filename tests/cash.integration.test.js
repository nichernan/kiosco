import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort(){
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const {port}=server.address();await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;
}

test('cash sessions keep sales, purchases, stock and physical cash consistent atomically',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.cash-test-'));
  const serverDir=join(runtime,'server'),dataDir=join(runtime,'data');
  await mkdir(serverDir,{recursive:true});await mkdir(dataDir,{recursive:true});
  const dbPath=join(dataDir,'kiosco.sqlite');
  await copyFile(resolve('server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`;
  const child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port),KIOSCO_DB_PATH:dbPath},stdio:'ignore'});
  t.after(async()=>{child.kill();if(child.exitCode===null)await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,1500))]);await rm(runtime,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}
  assert.equal(ready,true,'isolated SQLite API did not start');
  const setupResponse=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@kiosco.local',password:'temporary-test-password'})});
  assert.equal(setupResponse.status,201,'isolated admin setup failed');
  const authCookie=setupResponse.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',body)=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','Cookie':authCookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()}};
  const db=()=>new DatabaseSync(dbPath);
  const bootstrap=async()=>(await request('/bootstrap')).data;
  const state=async()=>{const b=await bootstrap();return{bootstrap:b,product:b.products.find(p=>p.id===b.products[0].id)}};
  const initial=await bootstrap(),categoryId=initial.categories[0].id;
  const product=(await request('/products','POST',{name:'Producto de prueba',sku:'CASH-TEST',category_id:categoryId,stock:20,cost:5,price:10})).data;
  assert.ok(product.id);
  const purchaseBody={product_id:product.id,quantity:2,unit_cost:5};
  const saleBody=(method='efectivo',amount=10)=>({items:[{id:product.id,quantity:1}],payments:[{method,amount}]});

  // Closed drawer rejects cash affecting operations without leaving partial rows or stock changes.
  let rejected=await request('/sales','POST',saleBody());
  assert.equal(rejected.status,409);assert.match(rejected.data.error,/No hay una caja abierta/);
  rejected=await request('/purchases','POST',purchaseBody);
  assert.equal(rejected.status,409);assert.match(rejected.data.error,/No hay una caja abierta/);
  let inspect=db();
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM sales').get().n,0);
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM purchases').get().n,0);
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,0);
  assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,20);inspect.close();

  // Non-cash tenders remain sales, with no physical cash movement (also when no drawer is open).
  for(const method of ['tarjeta','transferencia','qr']){
    const saved=await request('/sales','POST',saleBody(method,10));assert.equal(saved.status,201);
    assert.equal(saved.data.payments[0].method,method);
  }
  inspect=db();assert.equal(inspect.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,0);inspect.close();

  const opened=await request('/cash/open','POST',{amount:100});assert.equal(opened.status,201);
  const sale=await request('/sales','POST',{items:[{id:product.id,quantity:2}],payments:[{method:'efectivo',amount:10},{method:'qr',amount:10}]});
  assert.equal(sale.status,201);
  let cash=(await request('/cash')).data;assert.equal(cash.expected_cash,110);
  let movements=(await request(`/cash/${opened.data.id}/movements`)).data.movements;
  assert.equal(movements.length,1);assert.equal(movements[0].amount,10);assert.match(movements[0].note,/Venta #/);
  inspect=db();assert.deepEqual(inspect.prepare('SELECT method,amount FROM payments WHERE sale_id=? ORDER BY method').all(sale.data.id).map(row=>({...row})),[{method:'efectivo',amount:10},{method:'qr',amount:10}]);
  assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,15);inspect.close();

  const bought=await request('/purchases','POST',purchaseBody);assert.equal(bought.status,201);
  cash=(await request('/cash')).data;assert.equal(cash.expected_cash,100);
  movements=(await request(`/cash/${opened.data.id}/movements`)).data.movements;
  assert.equal(movements.length,2);assert.equal(movements.find(m=>m.kind==='purchase').amount,-10);
  inspect=db();assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,17);inspect.close();

  // Force failure after each route has already written its commercial and stock rows.
  inspect=db();inspect.exec("CREATE TRIGGER fail_sale_cash BEFORE INSERT ON cash_movements WHEN NEW.kind='sale' BEGIN SELECT RAISE(ABORT,'forced test failure'); END;");inspect.close();
  const rollbackSale=await request('/sales','POST',saleBody());assert.equal(rollbackSale.status,500);assert.doesNotMatch(rollbackSale.data.error,/SQLITE|forced test failure/);
  inspect=db();assert.equal(inspect.prepare('SELECT COUNT(*) n FROM sales').get().n,4);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM sale_items').get().n,4);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM payments').get().n,5);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,2);assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,17);inspect.exec('DROP TRIGGER fail_sale_cash');inspect.close();

  inspect=db();inspect.exec("CREATE TRIGGER fail_purchase_cash BEFORE INSERT ON cash_movements WHEN NEW.kind='purchase' BEGIN SELECT RAISE(ABORT,'forced test failure'); END;");inspect.close();
  const rollbackPurchase=await request('/purchases','POST',purchaseBody);assert.equal(rollbackPurchase.status,500);assert.doesNotMatch(rollbackPurchase.data.error,/SQLITE|forced test failure/);
  inspect=db();assert.equal(inspect.prepare('SELECT COUNT(*) n FROM purchases').get().n,1);assert.equal(inspect.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,2);assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,17);inspect.exec('DROP TRIGGER fail_purchase_cash');inspect.close();

  // Variant purchase and sale use the same atomic cash rules and preserve per-variant stock.
  const variantProduct=(await request('/products','POST',{name:'Producto con variante',sku:'CASH-VAR',category_id:categoryId,stock:4,cost:2,price:8})).data;
  assert.equal((await request(`/products/${variantProduct.id}`,'PATCH',{variants:[{name:'Rojo',sku:'CASH-VAR-R',stock:4},{name:'Azul',sku:'CASH-VAR-A',stock:0}]})).status,200);
  let variantState=(await bootstrap()).products.find(p=>p.id===variantProduct.id);const red=variantState.variants.find(v=>v.name==='Rojo'),blue=variantState.variants.find(v=>v.name==='Azul');
  assert.equal((await request('/purchases','POST',{product_id:variantProduct.id,variant_id:blue.id,quantity:3,unit_cost:2})).status,201);
  const variantSale=await request('/sales','POST',{items:[{id:variantProduct.id,variant_id:red.id,quantity:1}],payments:[{method:'efectivo',amount:8}]});assert.equal(variantSale.status,201,JSON.stringify(variantSale));
  variantState=(await bootstrap()).products.find(p=>p.id===variantProduct.id);
  assert.deepEqual(variantState.variants.map(v=>v.stock),[3,3]);
  cash=(await request('/cash')).data;assert.equal(cash.expected_cash,102);

  // Manual in/out and exact close reconcile mathematically; after close no cash sale or purchase can enter.
  assert.equal((await request('/cash/movements','POST',{kind:'income',amount:5,note:'Ajuste ingreso'})).status,201);
  assert.equal((await request('/cash/movements','POST',{kind:'expense',amount:2,note:'Ajuste egreso'})).status,201);
  cash=(await request('/cash')).data;assert.equal(cash.expected_cash,105);
  assert.equal((await request('/cash/close','POST',{counted_cash:105})).status,200);
  assert.equal((await request('/cash')).data,null);
  const closedSale=await request('/sales','POST',saleBody());assert.equal(closedSale.status,409);assert.match(closedSale.data.error,/No hay una caja abierta/);
  const closedPurchase=await request('/purchases','POST',purchaseBody);assert.equal(closedPurchase.status,409);assert.match(closedPurchase.data.error,/No hay una caja abierta/);
  const noncashAfterClose=await request('/sales','POST',saleBody('tarjeta',10));assert.equal(noncashAfterClose.status,201);
  inspect=db();assert.equal(inspect.prepare("SELECT status,closing_amount FROM cash_sessions WHERE id=?").get(opened.data.id).status,'closed');
  assert.equal(inspect.prepare('SELECT closing_amount FROM cash_sessions WHERE id=?').get(opened.data.id).closing_amount,105);
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM cash_movements').get().n,6);
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM purchases').get().n,2);
  assert.equal(inspect.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,16);inspect.close();
});
