import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function unusedPort() {
  const server=createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const {port}=server.address();
  await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
  return port;
}

test('stock and product variants remain consistent through purchases, sales, validation and atomic edits', async t=>{
  const runtime=await mkdtemp(join(process.cwd(),'.stock-test-'));
  const serverDir=join(runtime,'server');
  await mkdir(serverDir,{recursive:true});
  await copyFile(resolve('server/index.js'),join(serverDir,'index.js'));
  const port=await unusedPort();
  const base=`http://127.0.0.1:${port}/api`;
  const child=spawn(process.execPath,[join(serverDir,'index.js')],{
    cwd:process.cwd(),
    env:{...process.env,KIOSCO_PORT:String(port)},
    stdio:'ignore',
  });
  t.after(async()=>{
    child.kill();
    if(child.exitCode===null) await Promise.race([once(child,'exit'),new Promise(done=>setTimeout(done,1500))]);
    await rm(runtime,{recursive:true,force:true});
  });

  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    try{if((await fetch(`${base}/health`)).ok){ready=true;break}}catch{}
    await new Promise(done=>setTimeout(done,100));
  }
  assert.equal(ready,true,'isolated SQLite API did not start');
  const setupResponse=await fetch(`${base}/auth/setup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test Admin',email:'admin@kiosco.local',password:'temporary-test-password'})});
  assert.equal(setupResponse.status,201,'isolated admin setup failed');
  const authCookie=setupResponse.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',body)=>{
    const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','Cookie':authCookie},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    return {status:response.status,data};
  };
  const bootstrap=async()=> (await request('/bootstrap')).data;
  const initial=await bootstrap();
  const category_id=initial.categories[0].id;
  assert.equal((await request('/cash/open','POST',{amount:0})).status,201);

  // A product without variants keeps its stock on products.stock.
  const plain=(await request('/products','POST',{name:'Stock simple',sku:'TEST-PLAIN',category_id,stock:7,cost:2,price:5}));
  assert.equal(plain.status,201);
  const plainId=plain.data.id;
  assert.equal((await request('/purchases','POST',{product_id:plainId,quantity:3,unit_cost:2})).status,201);
  assert.equal((await bootstrap()).products.find(product=>product.id===plainId).stock,10);
  assert.equal((await request('/sales','POST',{items:[{id:plainId,quantity:2}],payments:[{method:'efectivo',amount:10}]})).status,201);
  assert.equal((await bootstrap()).products.find(product=>product.id===plainId).stock,8);
  assert.equal((await request('/sales','POST',{items:[{id:plainId,quantity:9}],payments:[{method:'efectivo',amount:45}]})).status,409);
  assert.equal((await bootstrap()).products.find(product=>product.id===plainId).stock,8);

  // Converting to variants must conserve existing general stock exactly.
  const variantProduct=(await request('/products','POST',{name:'Stock por talle',sku:'TEST-VARIANT-PRODUCT',category_id,stock:20,cost:4,price:9}));
  assert.equal(variantProduct.status,201);
  const variantId=variantProduct.data.id;
  const initialVariants=[{name:'A',sku:'TEST-VAR-A',stock:10},{name:'B',sku:'TEST-VAR-B',stock:10}];
  assert.equal((await request(`/products/${variantId}`,'PATCH',{variants:[{...initialVariants[0],stock:9},{...initialVariants[1],stock:10}]})).status,400);
  assert.equal((await bootstrap()).products.find(product=>product.id===variantId).stock,20);
  assert.equal((await request(`/products/${variantId}`,'PATCH',{variants:initialVariants})).status,200);
  let variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.equal(variantState.stock,20);
  assert.deepEqual(variantState.variants.map(variant=>variant.stock),[10,10]);
  const testDb=new DatabaseSync(join(runtime,'data','kiosco.sqlite'),{readOnly:true});
  assert.equal(testDb.prepare('SELECT stock FROM products WHERE id=?').get(variantId).stock,0,'variant product must not retain a second stored total');
  testDb.close();
  const [variantA,variantB]=variantState.variants;

  // New purchases must target an actual variant and alter only that stock.
  assert.equal((await request('/purchases','POST',{product_id:variantId,quantity:4,unit_cost:4})).status,400);
  assert.equal((await request('/purchases','POST',{product_id:variantId,variant_id:variantA.id,quantity:4,unit_cost:4})).status,201);
  assert.equal((await request('/purchases','POST',{product_id:variantId,variant_id:variantB.id,quantity:3,unit_cost:4})).status,201);
  variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.deepEqual(variantState.variants.map(variant=>variant.stock),[14,13]);
  assert.equal(variantState.stock,27);
  const history=await request('/purchases');
  assert.equal(history.data.find(purchase=>purchase.variant_id===variantA.id).variant_name,'A');

  // A sale decrements only its selected variant, and overselling is rejected.
  assert.equal((await request('/sales','POST',{items:[{id:variantId,variant_id:variantA.id,quantity:5}],payments:[{method:'efectivo',amount:45}]})).status,201);
  variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.deepEqual(variantState.variants.map(variant=>variant.stock),[9,13]);
  assert.equal(variantState.stock,22);
  assert.equal((await request('/sales','POST',{items:[{id:variantId,variant_id:variantA.id,quantity:10}],payments:[{method:'efectivo',amount:90}]})).status,409);
  assert.equal((await bootstrap()).products.find(product=>product.id===variantId).stock,22);

  // SKUs are unique across variants and products; failed creates roll back fully.
  const countBefore=(await bootstrap()).products.length;
  const duplicateCreate=await request('/products','POST',{name:'No debe persistir',sku:'TEST-DUP-PRODUCT',category_id,variants:[{name:'A',sku:'DUP-CODE',stock:1},{name:'B',sku:'dup-code',stock:1}]});
  assert.equal(duplicateCreate.status,409);
  assert.equal((await bootstrap()).products.length,countBefore);
  assert.equal((await request(`/products/${variantId}`,'PATCH',{name:'Cambio que debe revertirse',variants:[{...variantA,sku:'TEST-PLAIN'},{...variantB}]})).status,409);
  variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.equal(variantState.name,'Stock por talle');
  assert.deepEqual(variantState.variants.map(variant=>variant.stock),[9,13]);

  // A populated variant cannot be removed, even through the API.
  assert.equal((await request(`/products/${variantId}`,'PATCH',{variants:[variantB]})).status,400);
  variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.equal(variantState.variants.length,2);
  assert.equal(variantState.stock,22);

  // A variant referenced by a sale stays in the catalog even after its stock reaches zero.
  const variantBWithCurrentStock={...variantB,stock:13};
  assert.equal((await request(`/products/${variantId}`,'PATCH',{variants:[{...variantA,stock:0},variantBWithCurrentStock]})).status,200);
  assert.equal((await request(`/products/${variantId}`,'PATCH',{variants:[variantBWithCurrentStock]})).status,400);
  variantState=(await bootstrap()).products.find(product=>product.id===variantId);
  assert.equal(variantState.stock,13);
  assert.deepEqual(variantState.variants.map(variant=>variant.name),['A','B']);

  // The legacy variants-only endpoint must obey the same conversion rules.
  assert.equal((await request(`/products/${plainId}/variants`,'PUT',{variants:[]})).status,200);
  assert.equal((await bootstrap()).products.find(product=>product.id===plainId).stock,8);
  assert.equal((await request(`/products/${plainId}/variants`,'PUT',{variants:[{name:'Única',sku:'TEST-PLAIN-VAR',stock:7}]})).status,400);
  assert.equal((await bootstrap()).products.find(product=>product.id===plainId).stock,8);
  assert.equal((await request(`/products/${plainId}/variants`,'PUT',{variants:[{name:'Única',sku:'TEST-PLAIN-VAR',stock:8}]})).status,200);
  variantState=(await bootstrap()).products.find(product=>product.id===plainId);
  assert.equal(variantState.stock,8);
  assert.equal(variantState.variants[0].stock,8);
});
