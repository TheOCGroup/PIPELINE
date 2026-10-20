import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { handleAidenCallIntegration } from "../src/http/routes/aidenCallIntegration.js";

test("durable Aiden reports: auth, idempotency, retrieval", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aiden-intake-"));
  const file = join(folder, "reports.jsonl");
  const priorKey = process.env.AIDEN_CALL_INTAKE_TOKEN;
  const priorFile = process.env.AIDEN_CALL_RECORD_FILE;
  const token = "qa-aiden-reports-durable-secret-12345";
  process.env.AIDEN_CALL_INTAKE_TOKEN = token;
  process.env.AIDEN_CALL_RECORD_FILE = file;
  const ctx = { config: { dbPath: join(folder, "pipeline.db") } };
  const server = createServer((req, res) => handleAidenCallIntegration(req, res, ctx));
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const payload = { id: "call-test-001", message: "Interested in OCG LAB", from: "+13165550199" };
    for (let n = 0; n < 2; n++) {
      const sent = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(payload) });
      assert.equal(sent.status, 200);
    }
    const retrieved = await fetch(url, { headers: { authorization: "Bearer " + token } });
    assert.equal(retrieved.status, 200);
    const rows = (await retrieved.json()).messages;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].message, payload.message);
    const disk = await readFile(file, "utf8");
    assert.equal(disk.trim().split("\n").length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (priorKey === undefined) delete process.env.AIDEN_CALL_INTAKE_TOKEN; else process.env.AIDEN_CALL_INTAKE_TOKEN = priorKey;
    if (priorFile === undefined) delete process.env.AIDEN_CALL_RECORD_FILE; else process.env.AIDEN_CALL_RECORD_FILE = priorFile;
    await rm(folder, { recursive: true, force: true });
  }
});

test("operator inbox: authorized GET, unauthenticated GET rejected, webhook POST remains restricted", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-auth-"));
  const file = join(folder, "records.jsonl");
  const previousToken = process.env.AIDEN_CALL_INTAKE_TOKEN;
  const previousFile = process.env.AIDEN_CALL_RECORD_FILE;
  process.env.AIDEN_CALL_INTAKE_TOKEN = "test-aiden-private-intake-token-123456";
  process.env.AIDEN_CALL_RECORD_FILE = file;
  const ctx = { config: { dbPath: join(folder, "pipeline.db") } };
  const server = createServer((req, res) => {
    if (req.headers.authorization === "Bearer TEST_OPERATOR") req.operatorAuth = { actor: "test" };
    return handleAidenCallIntegration(req, res, ctx);
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const record = { id: "inbox-001", message: "Please call back", callerName: "Caller", from: "+13165550000" };
    const posted = await fetch(base, { method: "POST", headers: { authorization: "Bearer test-aiden-private-intake-token-123456", "content-type": "application/json" }, body: JSON.stringify(record) });
    assert.equal(posted.status, 200);
    const anonymous = await fetch(base);
    assert.equal(anonymous.status, 401);
    const operator = await fetch(base, { headers: { authorization: "Bearer TEST_OPERATOR" } });
    assert.equal(operator.status, 200);
    const result = await operator.json();
    assert.equal(result.messages[0].callerName, "Caller");
    const forbiddenWrite = await fetch(base, { method: "POST", headers: { authorization: "Bearer TEST_OPERATOR", "content-type": "application/json" }, body: JSON.stringify({ id: "unexpected", message: "bad" }) });
    assert.equal(forbiddenWrite.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previousToken === undefined) delete process.env.AIDEN_CALL_INTAKE_TOKEN; else process.env.AIDEN_CALL_INTAKE_TOKEN = previousToken;
    if (previousFile === undefined) delete process.env.AIDEN_CALL_RECORD_FILE; else process.env.AIDEN_CALL_RECORD_FILE = previousFile;
    await rm(folder, { recursive: true, force: true });
  }
});

test("separate inbox token permits read only and does not grant webhook write", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aiden-inbox-token-"));
  const priorInbox = process.env.AIDEN_INBOX_ACCESS_TOKEN;
  const priorIntake = process.env.AIDEN_CALL_INTAKE_TOKEN;
  const priorFile = process.env.AIDEN_CALL_RECORD_FILE;
  const inbox = "test-private-inbox-read-only-token-2026";
  const intake = "test-call-ingest-only-token-2026abcdef";
  process.env.AIDEN_INBOX_ACCESS_TOKEN = inbox;
  process.env.AIDEN_CALL_INTAKE_TOKEN = intake;
  process.env.AIDEN_CALL_RECORD_FILE = join(folder, "calls.jsonl");
  const ctx={config:{dbPath:join(folder,"db")}};
  const { authorizeAidenInboxBearer } = await import("../src/http/routes/aidenCallIntegration.js");
  const server=createServer((req,res)=>{
    if(req.method==="GET" && authorizeAidenInboxBearer(req))req.aidenInboxAuth=true;
    return handleAidenCallIntegration(req,res,ctx);
  });
  try{
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port;
    const headers={authorization:"Bearer "+inbox};
    const ok=await fetch(base,{headers});
    assert.equal(ok.status,200);
    const attemptedWrite=await fetch(base,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify({id:"should-not-write",message:"invalid"})});
    assert.equal(attemptedWrite.status,401);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    if(priorInbox===undefined)delete process.env.AIDEN_INBOX_ACCESS_TOKEN;else process.env.AIDEN_INBOX_ACCESS_TOKEN=priorInbox;
    if(priorIntake===undefined)delete process.env.AIDEN_CALL_INTAKE_TOKEN;else process.env.AIDEN_CALL_INTAKE_TOKEN=priorIntake;
    if(priorFile===undefined)delete process.env.AIDEN_CALL_RECORD_FILE;else process.env.AIDEN_CALL_RECORD_FILE=priorFile;
    await rm(folder,{recursive:true,force:true});
  }
});


test("archive, restore and delete persist, without deleting original call evidence", async () => {
  const folder=await mkdtemp(join(tmpdir(),"aiden-actions-"));
  const prevIntake=process.env.AIDEN_CALL_INTAKE_TOKEN;
  const prevFile=process.env.AIDEN_CALL_RECORD_FILE;
  process.env.AIDEN_CALL_INTAKE_TOKEN="test-call-token-private-archive-1234567";
  process.env.AIDEN_CALL_RECORD_FILE=join(folder,"records.jsonl");
  const ctx={config:{dbPath:join(folder,"db")}};
  const server=createServer((req,res)=>{
    if(req.headers.authorization==="Bearer TEST_INBOX")req.aidenInboxAuth=true;
    return handleAidenCallIntegration(req,res,ctx);
  });
  try{
    await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
    const url="http://127.0.0.1:"+server.address().port;
    const record={id:"call-123",message:"Callback needed"};
    const posted=await fetch(url,{method:"POST",headers:{authorization:"Bearer test-call-token-private-archive-1234567","content-type":"application/json"},body:JSON.stringify(record)});
    assert.equal(posted.status,200);
    const headers={authorization:"Bearer TEST_INBOX","content-type":"application/json"};
    const act=async(action)=>fetch(url,{method:"PATCH",headers,body:JSON.stringify({id:"call-123",action})});
    const get=async()=> (await (await fetch(url,{headers})).json()).messages;
    assert.equal((await act("archive")).status,200);
    assert.equal((await get())[0].inboxStatus,"archived");
    assert.equal((await act("restore")).status,200);
    assert.equal((await get())[0].inboxStatus,"inbox");
    assert.equal((await act("delete")).status,200);
    assert.equal((await get()).length,0);
    assert.match(await readFile(join(folder,"records.jsonl"),"utf8"),/call-123/);
    assert.equal((await act("restore")).status,409);
  }finally{
    await new Promise(ok=>server.close(ok));
    if(prevIntake===undefined)delete process.env.AIDEN_CALL_INTAKE_TOKEN;else process.env.AIDEN_CALL_INTAKE_TOKEN=prevIntake;
    if(prevFile===undefined)delete process.env.AIDEN_CALL_RECORD_FILE;else process.env.AIDEN_CALL_RECORD_FILE=prevFile;
    await rm(folder,{recursive:true,force:true});
  }
});

test("remembered inbox cookie authenticates reads without storing bearer in browser", async()=>{
  const previous=process.env.AIDEN_INBOX_ACCESS_TOKEN;
  const token="long-unique-private-inbox-test-token-1234";
  process.env.AIDEN_INBOX_ACCESS_TOKEN=token;
  const {issueInboxSession,authorizeInboxCookie}=await import("../src/http/routes/aidenCallIntegration.js");
  const server=createServer((req,res)=>{
    if(req.url==="/session")return issueInboxSession(req,res);
    return res.end(JSON.stringify({authorized:authorizeInboxCookie(req)}));
  });
  try{
    await new Promise(ok=>server.listen(0,"127.0.0.1",ok));
    const url="http://127.0.0.1:"+server.address().port;
    assert.equal((await fetch(url+"/session",{method:"POST"})).status,401);
    const login=await fetch(url+"/session",{method:"POST",headers:{authorization:"Bearer "+token}});
    assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie");
    assert.match(cookie,/HttpOnly/);
    assert.match(cookie,/Secure/);
    const valid=await fetch(url,{headers:{cookie:cookie.split(";")[0]}});
    assert.equal((await valid.json()).authorized,true);
    const bad=await fetch(url,{headers:{cookie:"aiden_inbox=1111111111."+"0".repeat(64)}});
    assert.equal((await bad.json()).authorized,false);
  }finally{
    await new Promise(ok=>server.close(ok));
    if(previous===undefined)delete process.env.AIDEN_INBOX_ACCESS_TOKEN;else process.env.AIDEN_INBOX_ACCESS_TOKEN=previous;
  }
});

test("recording playback requires inbox authorization and configured R2 signing", async () => {
  const {handleAidenRecordingPlayback}=await import("../src/http/routes/aidenCallIntegration.js");
  const folder=await mkdtemp(join(tmpdir(),"aiden-recording-test-"));
  const file=join(folder,"calls.jsonl");
  const previousFile=process.env.AIDEN_CALL_RECORD_FILE;
  const previousAccount=process.env.AIDEN_R2_ACCOUNT_ID;
  process.env.AIDEN_CALL_RECORD_FILE=file;
  delete process.env.AIDEN_R2_ACCOUNT_ID;
  const ctx={config:{dbPath:join(folder,"pipeline.db")}};
  const server=createServer((req,res)=>{
    if(req.headers.authorization==="Bearer TEST_OPERATOR")req.operatorAuth={actor:"test"};
    return handleAidenRecordingPlayback(req,res,ctx,new URL(req.url,"http://localhost"));
  });
  try {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base="http://127.0.0.1:"+server.address().port+"/?id=unknown";
    assert.equal((await fetch(base)).status,401);
    const r=await fetch(base,{headers:{authorization:"Bearer TEST_OPERATOR"}});
    assert.equal(r.status,503);
    assert.equal((await r.json()).error,"recording_provider_unavailable");
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if(previousFile===undefined)delete process.env.AIDEN_CALL_RECORD_FILE;else process.env.AIDEN_CALL_RECORD_FILE=previousFile;
    if(previousAccount===undefined)delete process.env.AIDEN_R2_ACCOUNT_ID;else process.env.AIDEN_R2_ACCOUNT_ID=previousAccount;
    await rm(folder,{recursive:true,force:true});
  }
});
