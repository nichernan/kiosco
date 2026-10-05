import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const {port}=server.address();await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;}

test('customers, categories and suppliers support CRUD, safe history and product/POS/purchase integration',async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.entities-test-')),serverDir=join(runtime,'server');await mkdir(serverDir,{recursive:true});await mkdir(join(runtime,'data'),{recursive:true});await copyFile(resolve('server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort(),base=`http://127.0.0.1:${port}/api`,child=spawn(process.execPath,[join(serverDir,'index.js')],{cwd:process.cwd(),env:{...process.env,KIOSCO_PORT:String(port)},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,2000))]);}await rm(runtime,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100));}assert.equal(ready,true,'isolated API did not start');
  const setupResponse=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@kiosco.local',password:'temporary-test-password'})});assert.equal(setupResponse.status,201);const authCookie=setupResponse.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',body)=>{const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','Cookie':authCookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()}};
  const boot=(await request('/bootstrap')).data,category=(await request('/categories','POST',{name:'Bebidas test',color:'#2299aa'}));assert.equal(category.status,201);
  assert.equal((await request('/categories')).data.some(c=>c.id===category.data.id),true);
  assert.equal((await request(`/categories/${category.data.id}`,'PATCH',{name:'Bebidas editadas',color:'#112233'})).data.name,'Bebidas editadas');
  assert.equal((await request('/categories','POST',{name:''})).status,400);
  const supplier=(await request('/suppliers','POST',{name:'Distribuidora test'}));assert.equal(supplier.status,201);assert.equal((await request(`/suppliers/${supplier.data.id}`,'PATCH',{name:'Distribuidora editada'})).data.name,'Distribuidora editada');
  const customer=(await request('/customers','POST',{name:'María López',tax_id:'20-123.456'}));assert.equal(customer.status,201);
  assert.equal((await request('/customers')).data.some(c=>c.id===customer.data.id),true);
  assert.equal((await request('/customers?search=López')).data.some(c=>c.id===customer.data.id),true);
  assert.equal((await request('/customers?search=123.456')).data.some(c=>c.id===customer.data.id),true);
  assert.equal((await request('/customers?include_archived=true&search=20123456')).data.some(c=>c.id===customer.data.id),true);
  assert.equal((await request('/customers','POST',{name:'Duplicada',tax_id:'20123456'})).status,409);
  assert.equal((await request(`/customers/${customer.data.id}`,'PATCH',{name:'María Editada',tax_id:'20-123.456',phone:'111',email:'maria@example.com'})).data.name,'María Editada');
  assert.equal((await request(`/customers/${customer.data.id}`,'PATCH',{name:'Inválida',email:'no-es-email'})).status,400);
  assert.equal((await request('/products','POST',{name:'Bebida',sku:'ENTITY-001',category_id:category.data.id,supplier_id:supplier.data.id,stock:5,cost:2,price:10})).status,201);
  assert.equal((await request('/products','POST',{name:'Categoría inválida',sku:'ENTITY-002',category_id:'missing',stock:1,price:1})).status,400);
  const product=(await request('/products','POST',{name:'Bebida integrada',sku:'ENTITY-003',category_id:category.data.id,supplier_id:supplier.data.id,stock:5,cost:2,price:10})).data;
  assert.equal((await request(`/products/${product.id}`,'PATCH',{category_id:'missing'})).status,400);
  assert.equal((await request(`/categories/${category.data.id}`,'DELETE')).status,409);
  assert.equal((await request(`/suppliers/${supplier.data.id}`,'DELETE')).status,409);
  const cash=await request('/cash/open','POST',{amount:100});assert.equal(cash.status,201);
  const sale=await request('/sales','POST',{items:[{id:product.id,quantity:1}],payments:[{method:'efectivo',amount:10}],customer_id:customer.data.id});assert.equal(sale.status,201);
  const history=await request(`/customers/${customer.data.id}/history`);assert.equal(history.status,200);assert.equal(history.data.summary.sales_count,1);assert.equal(history.data.summary.total_purchased,10);
  const archived=await request(`/customers/${customer.data.id}`,'DELETE');assert.equal(archived.status,200);assert.equal(archived.data.archived,true);
  assert.equal((await request(`/sales/${sale.data.id}`)).data.customer.name,'María Editada');
  assert.equal((await request(`/sales`)).data.items.find(s=>s.id===sale.data.id).customer_name,'María Editada');
  assert.equal((await request('/bootstrap')).data.customers.some(c=>c.id===customer.data.id),false);
  assert.equal((await request('/sales','POST',{items:[{id:product.id,quantity:1}],payments:[{method:'qr',amount:10}],customer_id:customer.data.id})).status,400);
  assert.equal((await request(`/customers/${customer.data.id}/archive`,'PATCH',{active:1})).status,200);
  const purchase=await request('/purchases','POST',{product_id:product.id,quantity:1,unit_cost:2});assert.equal(purchase.status,201);
  assert.equal((await request('/suppliers')).data.find(s=>s.id===supplier.data.id).purchase_count,1);
  assert.equal((await request(`/customers/${customer.data.id}`,'DELETE')).data.archived,true);
  const realDb=new DatabaseSync(join(runtime,'data','kiosco.sqlite'));
  const unusedCategory=(await request('/categories','POST',{name:'Vacía'})).data;
  assert.equal((await request(`/categories/${unusedCategory.id}`,'DELETE')).status,200);
  const unusedSupplier=(await request('/suppliers','POST',{name:'Vacío'})).data;
  assert.equal((await request(`/suppliers/${unusedSupplier.id}`,'DELETE')).status,200);
  const noHistory=(await request('/customers','POST',{name:'Sin historial'})).data;
  assert.equal((await request(`/customers/${noHistory.id}`,'DELETE')).data.archived,false);
  assert.equal(realDb.prepare('SELECT COUNT(*) AS n FROM customers WHERE id=?').get(noHistory.id).n,0);realDb.close();
  assert.equal((await request('/customers?include_archived=true&search=María')).data.some(c=>c.id===customer.data.id&&c.active===0),true);
});


