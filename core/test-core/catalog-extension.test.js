"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),Models=require('../../electron/credit-models'),Extension=require('../lib/koin-network/catalog-extension');
const config=require('../lib/koin-network/credit-service.json').config,prices=require('../lib/koin-network/credit-model-prices.json'),P=require('../lib/koin-network/job-protocol');
test('approved additive prices preserve the exact original fifteen-model commitment',()=>{
 const full=Models.approvedTariffs(prices.tariffs,config,prices.policyHash),base=full.filter(t=>t.model!=='lfm3-1.7b');assert.equal(full.length,16);assert.equal(Models.tariffs(base,config.policyHash).length,15);
 assert.deepEqual(Models.approvedTariffs(base,config),base);assert.deepEqual(Models.approvedTariffs(full,config),full);
 for(const change of [x=>x[0].inputAtomsPerMillion='1',x=>x[0].modelHash=P.hash('other'),x=>x.pop()]){const values=structuredClone(full);change(values);assert.throws(()=>Models.approvedTariffs(values,config,prices.policyHash));}
 assert.throws(()=>Models.approvedTariffs(full,{...config,catalogExtension:{...config.catalogExtension,models:['koinos-fast']}},prices.policyHash));
});
test('only explicitly added model targets differ; certificate and account target stays unchanged',()=>{
 const target={policyHash:config.policyHash,domain:'same'},original=structuredClone(target);
 assert.deepEqual(Extension.target(target,config.catalogExtension,'koinos-fast'),target);assert.equal(Extension.target(target,config.catalogExtension,'lfm3-1.7b').policyHash,prices.policyHash);assert.deepEqual(target,original);
 assert.throws(()=>Extension.validate({...config.catalogExtension,extra:true},config.policyHash));assert.deepEqual(Extension.headers({...config,catalogExtension:undefined}),{});
});
test('catalog negotiation accepts fresh legacy and extended catalogs but rejects a forged commitment or expired availability',()=>{
 const now=100000,make=tariffs=>({schema:1,policyHash:tariffs.length===16?prices.policyHash:config.policyHash,tariffs,asOf:now,validUntil:now+15000,models:tariffs.map(t=>({model:t.model,available:false,providers:0}))});
 assert.equal(Models.catalog(make(prices.tariffs),config,now).models.length,16);assert.equal(Models.catalog(make(prices.tariffs.filter(t=>t.model!=='lfm3-1.7b')),config,now).models.length,15);
 assert.throws(()=>Models.catalog({...make(prices.tariffs),policyHash:P.hash('other')},config,now));assert.throws(()=>Models.catalog(make(prices.tariffs),config,now+15000));
});
