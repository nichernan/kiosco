import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const {port}=server.address();await new Promise(done=>server.close(done));return port;}

test('full sale voids atomically reverse stock and tender, preserve history, and enforce admin permission',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.sales-void-test-')),serverDir=join(runtime,'server'),dataDir=join(runtime,'data');await mkdir(serverDir,{recursive:true});await mkdir(dataDir,{recursive:true});
  const dbPath=join(dataDir,'kiosco.sqlite');await copyFile(join(process.cwd(),'server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`,child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port),KIOSCO_DB_PATH:dbPath},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,1500))]);}await rm(runtime,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}assert.equal(ready,true,'isolated API did not start');
  const req=async(path,method='GET',body,cookie='')=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};};
  const setup=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Admin',email:'admin@kiosco.local',password:'administrator-password'})});assert.equal(setup.status,201);const admin=setup.headers.get('set-cookie').split(';')[0];
  const boot=(await req('/bootstrap','GET',undefined,admin)).data,category=boot.categories[0];
  const product=(await req('/products','POST',{name:'Producto anulable',sku:'VOID-001',category_id:category.id,stock:20,cost:2,price:10},admin)).data;
  const employee=(await req('/users','POST',{name:'Empleado',email:'employee@kiosco.local',password:'employee-password',role:'employee'},admin)).data;
  const employeeLogin=await req('/auth/login','POST',{email:employee.email,password:'employee-password'});const employeeCookie=employeeLogin.cookie;assert.equal(employeeLogin.status,200);
  const makeSale=async(method,quantity=1,payments)=>req('/sales','POST',{items:[{id:product.id,quantity}],payments:payments||[{method,amount:10*quantity}]},admin);
  const voidSale=(id,reason='Error de carga')=>req(`/sales/${id}/void`,'POST',{reason},admin);
  const readDb=()=>new DatabaseSync(dbPath);

  // Non-cash methods reverse only the recorded tender and never create physical-cash movements.
  for(const method of ['tarjeta','transferencia','qr']){
    const sale=await makeSale(method);assert.equal(sale.status,201);
    if(method==='tarjeta'){
      const beforeReport=await req('/reports/sales','GET',undefined,admin);assert.equal(beforeReport.data.sale_count,1);assert.equal(beforeReport.data.total_sales,10);assert.equal(beforeReport.data.payment_totals.tarjeta,10);
      assert.equal((await req(`/sales/${sale.data.id}/void`,'POST',{reason:''},admin)).status,400,'a reason is mandatory');
      assert.equal((await req(`/sales/${sale.data.id}`,'GET',undefined)).status,401,'unauthenticated detail is rejected');
      assert.equal((await req(`/sales/${sale.data.id}/void`,'POST',{reason:'Empleado intenta anular'},employeeCookie)).status,403);
      assert.equal((await req(`/sales/${sale.data.id}`,'GET',undefined,employeeCookie)).status,200,'employee may consult a sale');
    }
    const originalDb=readDb();const originalStock=originalDb.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock;originalDb.close();
    if(method==='tarjeta')assert.equal((await req(`/products/${product.id}`,'PATCH',{active:0},admin)).status,200);
    if(method==='qr'){const expiredDate=new Date();expiredDate.setUTCDate(expiredDate.getUTCDate()-3);assert.equal((await req(`/products/${product.id}`,'PATCH',{expires_on:expiredDate.toISOString().slice(0,10)},admin)).status,200);}
    const result=await voidSale(sale.data.id,`Corrección de ${method}`);assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal((await req(`/sales/${sale.data.id}/void`,'POST',{reason:'Anulación repetida'},admin)).status,409);
    let db=readDb();assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,originalStock+1);assert.equal(db.prepare('SELECT active FROM products WHERE id=?').get(product.id).active,method==='tarjeta'?0:1);assert.equal(db.prepare('SELECT status FROM sales WHERE id=?').get(sale.data.id).status,'voided');assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements WHERE sale_id=?').get(sale.data.id).n,0);assert.equal(db.prepare('SELECT method,amount FROM sale_adjustment_payments WHERE adjustment_id=?').get(result.data.adjustment_id).method,method);db.close();
    if(method==='qr'){const restored=(await req('/products','GET',undefined,admin)).data.find(item=>item.id===product.id);assert.equal(restored.expiry_status,'expired','void does not invent or erase expiry history');assert.equal((await req(`/products/${product.id}`,'PATCH',{expires_on:''},admin)).status,200);}
    if(method==='tarjeta')assert.equal((await req(`/products/${product.id}`,'PATCH',{active:1},admin)).status,200);
  }

  // An employee cannot void a sale; the admin can void mixed-tender payments atomically.
  const closedCashSale=await makeSale('efectivo');assert.equal(closedCashSale.status,409,'cash sale cannot be created without a drawer');
  const closedSession=(await req('/cash/open','POST',{amount:100},admin)).data;
  const cashSale=await makeSale('efectivo');assert.equal(cashSale.status,201);
  assert.equal((await req('/cash','GET',undefined,admin)).data.expected_cash,110);
  assert.equal((await req('/cash/close','POST',{counted_cash:110},admin)).status,200);
  assert.equal((await voidSale(cashSale.data.id)).status,409,'cash void needs an open session');
  const nextSession=await req('/cash/open','POST',{amount:50},admin);assert.equal(nextSession.status,201);
  const beforeRollback=readDb();const stockBefore=beforeRollback.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock;const statusBefore=beforeRollback.prepare('SELECT status FROM sales WHERE id=?').get(cashSale.data.id).status;beforeRollback.exec("CREATE TRIGGER fail_void_cash BEFORE INSERT ON cash_movements WHEN NEW.kind='sale_void' BEGIN SELECT RAISE(ABORT,'forced void rollback'); END;");beforeRollback.close();
  const failed=await voidSale(cashSale.data.id);assert.equal(failed.status,500);assert.doesNotMatch(failed.data.error,/SQLITE|forced void rollback/);
  let db=readDb();assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(product.id).stock,stockBefore);assert.equal(db.prepare('SELECT status FROM sales WHERE id=?').get(cashSale.data.id).status,statusBefore);assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_adjustments WHERE sale_id=?').get(cashSale.data.id).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements WHERE sale_id=? AND kind=\'sale_void\'').get(cashSale.data.id).n,0);db.exec('DROP TRIGGER fail_void_cash');db.close();assert.equal((await req('/cash','GET',undefined,admin)).data.expected_cash,50);
  const voidedCash=await voidSale(cashSale.data.id);assert.equal(voidedCash.status,200);assert.equal((await req('/cash','GET',undefined,admin)).data.expected_cash,40);

  const mixed=await req('/sales','POST',{items:[{id:product.id,quantity:2}],payments:[{method:'efectivo',amount:10},{method:'qr',amount:10}]},admin);assert.equal(mixed.status,201);assert.equal((await req('/cash','GET',undefined,admin)).data.expected_cash,50);
  const mixedVoid=await voidSale(mixed.data.id,'Pago mixto duplicado');assert.equal(mixedVoid.status,200);assert.equal(mixedVoid.data.cash_reversed,10);assert.equal((await req('/cash','GET',undefined,admin)).data.expected_cash,40);
  db=readDb();assert.deepEqual(db.prepare('SELECT method,amount FROM sale_adjustment_payments WHERE adjustment_id=? ORDER BY method').all(mixedVoid.data.adjustment_id).map(row=>({...row})),[{method:'efectivo',amount:10},{method:'qr',amount:10}]);assert.equal(db.prepare("SELECT SUM(amount) amount FROM cash_movements WHERE sale_id=? AND kind='sale_void'").get(mixed.data.id).amount,-10);db.close();

  // Variants are restored only to the variant sold; the product parent stock remains zero.
  const variantProduct=(await req('/products','POST',{name:'Producto con talle',sku:'VOID-VAR',category_id:category.id,stock:5,cost:1,price:7},admin)).data;
  assert.equal((await req(`/products/${variantProduct.id}`,'PATCH',{variants:[{name:'Rojo',sku:'VOID-VAR-R',stock:2},{name:'Azul',sku:'VOID-VAR-A',stock:3}]},admin)).status,200);
  let variant=(await req('/products','GET',undefined,admin)).data.find(item=>item.id===variantProduct.id);const red=variant.variants.find(item=>item.name==='Rojo'),blue=variant.variants.find(item=>item.name==='Azul');
  const variantSale=await req('/sales','POST',{items:[{id:variantProduct.id,variant_id:red.id,quantity:1}],payments:[{method:'qr',amount:7}]},admin);assert.equal(variantSale.status,201);
  assert.equal((await req(`/products/${variantProduct.id}/variants`,'PUT',{variants:[]},admin)).status,400,'a sold variant cannot be removed from its history');
  const variantVoid=await voidSale(variantSale.data.id,'Variante incorrecta');assert.equal(variantVoid.status,200);
  variant=(await req('/products','GET',undefined,admin)).data.find(item=>item.id===variantProduct.id);assert.equal(variant.variants.find(item=>item.id===red.id).stock,2);assert.equal(variant.variants.find(item=>item.id===blue.id).stock,3);db=readDb();assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get(variantProduct.id).stock,0);db.close();

  // Original tickets remain visible, while sales reports exclude every voided ticket and tender.
  const list=await req('/sales?page=1&limit=25','GET',undefined,admin);assert.equal(list.status,200);assert.ok(list.data.items.every(item=>item.status==='voided'));assert.ok(list.data.items.every(item=>item.net_total===0));
  const report=await req('/reports/sales','GET',undefined,admin);assert.equal(report.data.sale_count,0);assert.equal(report.data.total_sales,0);assert.deepEqual(report.data.payment_totals,{efectivo:0,tarjeta:0,transferencia:0,qr:0});
  const detail=await req(`/sales/${mixed.data.id}`,'GET',undefined,admin);assert.equal(detail.data.status,'voided');assert.equal(detail.data.total,20);assert.equal(detail.data.refunded_total,20);assert.equal(detail.data.net_total,0);assert.equal(detail.data.void.reason,'Pago mixto duplicado');assert.equal(detail.data.void.user_name,'Admin');assert.equal(detail.data.void.payments.length,2);
  db=readDb();assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n,6);assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_audit_log WHERE action=\'sale.void\'').get().n,6);assert.equal(db.prepare('SELECT status FROM cash_sessions WHERE id=?').get(closedSession.id).status,'closed');assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements WHERE session_id=? AND kind=\'sale_void\'').get(closedSession.id).n,0);db.close();
});
