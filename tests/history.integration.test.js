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

test('sales and cash histories filter, paginate, link records and report correct tender totals',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.history-test-'));
  const serverDir=join(runtime,'server');await mkdir(serverDir,{recursive:true});
  const dbPath=join(runtime,'data','kiosco.sqlite');await mkdir(join(runtime,'data'),{recursive:true});
  await copyFile(resolve('server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`;
  const child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port)},stdio:'ignore'});
  t.after(async()=>{
    if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,2000))]);}
    await rm(runtime,{recursive:true,force:true});
  });
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}
  assert.equal(ready,true,'isolated API did not start');
  const setupResponse=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@kiosco.local',password:'temporary-test-password'})});
  assert.equal(setupResponse.status,201,'isolated admin setup failed');
  const authCookie=setupResponse.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',body)=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','Cookie':authCookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()}};
  const initial=(await request('/bootstrap')).data,categoryId=initial.categories[0].id;
  const customer=(await request('/customers','POST',{name:'Cliente histórico'})).data;
  const product=(await request('/products','POST',{name:'Producto histórico',sku:'HISTORY-001',category_id:categoryId,stock:100,cost:4,price:10})).data;
  const session=(await request('/cash/open','POST',{amount:1000})).data;
  const methods=['efectivo','qr','tarjeta','transferencia'];
  let knownTicketSale;
  for(let index=0;index<31;index++){
    const body={items:[{id:product.id,quantity:1}],payments:[{method:methods[index%4],amount:10}],...(index%2===0?{customer_id:customer.id}:{})};
    const saved=await request('/sales','POST',body);assert.equal(saved.status,201);
    if(index===0)knownTicketSale=saved.data;
  }
  const variantProduct=(await request('/products','POST',{name:'Variante histórica',sku:'HISTORY-VAR',category_id:categoryId,stock:2,cost:4,price:15})).data;
  assert.equal((await request(`/products/${variantProduct.id}`,'PATCH',{variants:[{name:'Rojo',sku:'HISTORY-VAR-R',stock:2},{name:'Azul',sku:'HISTORY-VAR-A',stock:0}]})).status,200);
  const variants=(await request('/bootstrap')).data.products.find(p=>p.id===variantProduct.id).variants;
  const red=variants.find(v=>v.name==='Rojo'),blue=variants.find(v=>v.name==='Azul');
  const purchase=await request('/purchases','POST',{product_id:variantProduct.id,variant_id:blue.id,quantity:3,unit_cost:4});assert.equal(purchase.status,201);
  const variantSale=await request('/sales','POST',{items:[{id:variantProduct.id,variant_id:red.id,quantity:1}],payments:[{method:'efectivo',amount:15}]});assert.equal(variantSale.status,201);

  const db=new DatabaseSync(dbPath);
  db.prepare("UPDATE sales SET created_at='2025-03-15 10:00:00' WHERE ticket_number BETWEEN 1 AND 16").run();
  db.prepare("UPDATE sales SET created_at='2025-03-16 10:00:00' WHERE ticket_number BETWEEN 17 AND 31").run();
  db.prepare("UPDATE sales SET created_at='2025-03-17 10:00:00' WHERE ticket_number=32").run();
  db.close();
  assert.ok(knownTicketSale?.id);

  // Server pagination and filters do not fetch or filter the entire history in the browser.
  let page=await request('/sales?page=1&limit=25');assert.equal(page.status,200);assert.equal(page.data.total,32);assert.equal(page.data.items.length,25);assert.equal(page.data.total_pages,2);
  page=await request('/sales?page=2&limit=25');assert.equal(page.data.items.length,7);
  assert.equal((await request('/sales?page=1&limit=10')).status,400);
  const exactTicket=await request('/sales?q=1');assert.equal(exactTicket.data.total,1);assert.equal(exactTicket.data.items[0].ticket_number,1);
  const byMethod=await request('/sales?method=efectivo');assert.equal(byMethod.data.total,9);
  const byCustomer=await request(`/sales?customer_id=${customer.id}`);assert.equal(byCustomer.data.total,16);
  const byDate=await request('/sales?from=2025-03-15&to=2025-03-15');assert.equal(byDate.data.total,16);
  assert.equal((await request('/sales?from=2025-03-17&to=2025-03-15')).status,400);

  const detail=await request(`/sales/${variantSale.data.id}`);assert.equal(detail.status,200);
  assert.equal(detail.data.items[0].variant_name,'Rojo');assert.equal(detail.data.items[0].quantity,1);
  assert.equal(detail.data.payments[0].method,'efectivo');assert.equal(detail.data.cash_movements.length,1);
  assert.equal(detail.data.cash_movements[0].sale_id,variantSale.data.id);assert.equal(detail.data.session.id,session.id);
  const historicalCashSale=await request(`/sales/${knownTicketSale.id}`);assert.equal(historicalCashSale.data.cash_movements.length,1);

  const report=await request('/reports/sales');assert.equal(report.status,200);
  assert.equal(report.data.sale_count,32);assert.equal(report.data.total_sales,325);
  assert.deepEqual({...report.data.payment_totals},{efectivo:95,tarjeta:80,transferencia:70,qr:80});
  const rangedReport=await request('/reports/sales?from=2025-03-15&to=2025-03-15');
  assert.equal(rangedReport.data.sale_count,16);assert.equal(rangedReport.data.total_sales,160);assert.equal(rangedReport.data.payment_totals.efectivo,40);

  assert.equal((await request('/cash/movements','POST',{kind:'income',amount:5,note:'Ingreso de prueba'})).status,201);
  assert.equal((await request('/cash/movements','POST',{kind:'expense',amount:2,note:'Egreso de prueba'})).status,201);
  const liveSession=await request(`/cash/${session.id}/movements?page=1&limit=25`);
  assert.equal(liveSession.data.expected_cash,1086);assert.equal(liveSession.data.total_income,100);assert.equal(liveSession.data.total_expenses,14);
  assert.equal(liveSession.data.total,12);assert.equal(liveSession.data.movements.find(m=>m.purchase_id===purchase.data.id).purchase_id,purchase.data.id);
  const closed=await request('/cash/close','POST',{counted_cash:1086});assert.equal(closed.status,200);assert.equal(closed.data.difference,0);
  const sessions=await request('/cash/sessions?page=1&limit=25');assert.equal(sessions.status,200);assert.equal(sessions.data.total,1);
  assert.equal(sessions.data.items[0].status,'closed');assert.equal(sessions.data.items[0].expected_cash,1086);
  assert.equal(sessions.data.items[0].closing_amount,1086);assert.equal(sessions.data.items[0].difference,0);
  assert.equal(sessions.data.items[0].total_income,100);assert.equal(sessions.data.items[0].total_expenses,14);
});
