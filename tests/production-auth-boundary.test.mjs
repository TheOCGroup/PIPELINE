import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { createApp } from '../src/app/createApp.js';
import { makeTempDb, startApp, testConfig } from './helpers/temporaryDatabase.mjs';
const keyText='test-only-operator-01234567890123456789012345';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const kid='qa-read-key';
async function jwt(){const key=await importPKCS8(pair.privateKey.export({type:'pkcs8',format:'pem'}),'RS256');return new SignJWT({scope:'ocg-one.pipeline.read'}).setProtectedHeader({alg:'RS256',typ:'JWT',kid}).setIssuer('ocg-one').setAudience('pipeline').setSubject('qa-service').setIssuedAt().setExpirationTime('60s').sign(key);}
async function fixture(t){const temp=makeTempDb();const {app,baseUrl}=await startApp(createApp,testConfig(temp.dbPath,{env:'production',integrationEnabled:true,readOnly:false,tenantId:'ocg-one',operatorSecret:keyText,servicePublicKeys:{[kid]:pair.publicKey.export({type:'spki',format:'pem'})},handoffPublicKeys:{},dataSource:'empty'}));t.after(()=>{app.close();temp.cleanup()});return baseUrl;}
test('founder credential remains usable with integration on',async t=>{const base=await fixture(t);const headers={Authorization:`Bearer ${keyText}`,'Content-Type':'application/json'};const r=await fetch(`${base}/api/v1/opportunities`,{headers});assert.equal(r.status,200);const w=await fetch(`${base}/api/v1/operator/notes`,{method:'POST',headers,body:JSON.stringify({opportunityId:'missing',text:'qa'})});assert.notEqual(w.status,401);assert.notEqual(w.status,403);});
test('read-scoped service identity cannot write and invalid credentials fail',async t=>{const base=await fixture(t);const token=await jwt();const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};const read=await fetch(`${base}/api/v1/opportunities`,{headers});assert.equal(read.status,200);const w=await fetch(`${base}/api/v1/operator/notes`,{method:'POST',headers,body:JSON.stringify({opportunityId:'missing',text:'qa'})});assert.equal(w.status,403);assert.equal((await w.json()).error,'forbidden_insufficient_scope');assert.equal((await fetch(`${base}/api/v1/opportunities`)).status,401);assert.equal((await fetch(`${base}/api/v1/opportunities`,{headers:{Authorization:'Bearer bad'}})).status,403);});


