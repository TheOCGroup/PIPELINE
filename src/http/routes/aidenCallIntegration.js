import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { timingSafeEqual, createHmac } from "node:crypto";



const MAX_BYTES = 256 * 1024;
const target = (ctx) => resolve(process.env.AIDEN_CALL_RECORD_FILE || resolve(dirname(ctx.config.dbPath), "aiden-call-records.jsonl"));

const stateTarget = ctx => resolve(dirname(target(ctx)), "aiden-message-state.json");
function auth(req) {
  const secret = process.env.AIDEN_CALL_INTAKE_TOKEN || "";
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || supplied.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}
export function authorizeAidenInboxBearer(req) {
  const secret = process.env.AIDEN_INBOX_ACCESS_TOKEN || "";
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return secret.length >= 32 && supplied.length === secret.length &&
    timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}
const YEAR_SECONDS=31536000;
function signedExpiry(exp){return createHmac("sha256",process.env.AIDEN_INBOX_ACCESS_TOKEN||"").update("aiden-inbox-v1:"+exp).digest("hex")}
export function issueInboxSession(req,res){
  if(req.method!=="POST"||!authorizeAidenInboxBearer(req))return send(res,401,{ok:false,error:"unauthorized"});
  const exp=Math.floor(Date.now()/1000)+YEAR_SECONDS;
  res.setHeader("Set-Cookie","aiden_inbox="+exp+"."+signedExpiry(exp)+"; Path=/api/v1/aiden; Max-Age="+YEAR_SECONDS+"; HttpOnly; Secure; SameSite=Lax");
  return send(res,200,{ok:true,remembered:true});
}
export function authorizeInboxCookie(req){
  if((process.env.AIDEN_INBOX_ACCESS_TOKEN||"").length<32)return false;
  const raw=String(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("aiden_inbox="))?.slice(12);
  if(!raw)return false;
  const [exp,mac]=raw.split(".");
  if(!/^\d{10}$/.test(exp)||!/^[a-f0-9]{64}$/.test(mac)||Number(exp)<=Date.now()/1000)return false;
  return timingSafeEqual(Buffer.from(mac),Buffer.from(signedExpiry(exp)));
}
function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("too_large");
  }
  return JSON.parse(text);
}
let stateWriteQueue = Promise.resolve();
function enqueueStateChange(fn) {
  const run = stateWriteQueue.catch(() => {}).then(fn);
  stateWriteQueue = run;
  return run;
}
async function readState(ctx) {
  try { return JSON.parse(await readFile(stateTarget(ctx), "utf8")); }
  catch(e) { if(e.code==="ENOENT") return {}; throw e; }
}
// Durable state write: temp file, fsync, atomic rename, directory fsync
// (best-effort). This file backs both the operator inbox and the gateway
// trash lifecycle, so a crash must never leave a torn or unflushed state.
async function writeStateAtomic(ctx, state) {
  const file = stateTarget(ctx);
  await mkdir(dirname(file), { recursive: true });
  const staging = file + ".tmp";
  const handle = await open(staging, "w");
  try {
    await handle.writeFile(JSON.stringify(state), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(staging, file);
  try {
    const dir = await open(dirname(file), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { /* directory fsync unsupported on some platforms: rename stays atomic */ }
}
async function updateState(ctx,id,action) {
  return enqueueStateChange(async()=>{
    const state=await readState(ctx);
    const current=state[id]?.status;
    // "purged" is terminal for every operator action.
    if(current==="purged") return {ok:false,error:"already_purged"};
    if(current==="deleted" && action!=="delete") return {ok:false,error:"already_deleted"};
    // A trashed record must be restored before it can be archived.
    if(current==="trashed" && action==="archive") return {ok:false,error:"already_trashed"};
    state[id]={status:action==="archive"?"archived":action==="restore"?"inbox":"deleted",updatedAt:new Date().toISOString()};
    await writeStateAtomic(ctx,state);
    return {ok:true,id,status:state[id].status};
  });
}
export async function handleAidenRecordingPlayback(req, res, ctx, url) {
  if (req.method !== "GET") return send(res,405,{ok:false,error:"method_not_allowed"});
  if (!(req.operatorAuth || req.pipelineSession || req.aidenInboxAuth)) return send(res,401,{ok:false,error:"unauthorized"});
  const id=url.searchParams.get("id")||"";
  if(!id||id.length>160) return send(res,400,{ok:false,error:"invalid_id"});
  const key=process.env.VAPI_PRIVATE_API_KEY||"";
  if(!key)return send(res,503,{ok:false,error:"recording_provider_unavailable"});
  let raw="";try{raw=await readFile(target(ctx),"utf8")}catch(e){if(e.code!=="ENOENT")throw e}
  const states=await readState(ctx);
  if(["deleted","trashed","purged"].includes(states[id]?.status))return send(res,404,{ok:false,error:"not_found"});
  const found=raw.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).find(x=>x?.id===id);
  if(!found||typeof found.recordingUrl!=="string")return send(res,404,{ok:false,error:"not_found"});
  if(!/^[a-f0-9]{8}-[a-f0-9-]{27,45}$/i.test(id))return send(res,422,{ok:false,error:"invalid_call_id"});
  try{
    const upstream=await fetch("https://api.vapi.ai/call/"+encodeURIComponent(id)+"/mono-recording",{headers:{Authorization:"Bearer "+key},redirect:"manual",signal:AbortSignal.timeout(10000)});
    if(upstream.status===404)return send(res,404,{ok:false,error:"recording_not_available"});
    if(![302,307].includes(upstream.status))return send(res,502,{ok:false,error:"recording_provider_failed"});
    const signed=new URL(upstream.headers.get("location"));
    if(signed.protocol!=="https:"||signed.username||signed.password||!signed.hostname.endsWith(".r2.cloudflarestorage.com"))return send(res,502,{ok:false,error:"invalid_recording_redirect"});
    res.writeHead(302,{Location:signed.toString(),"cache-control":"no-store","referrer-policy":"no-referrer"});res.end();
  }catch{return send(res,502,{ok:false,error:"recording_provider_unavailable"})}
}
// Gateway-facing trash lifecycle over the durable message state file.
// Auth: integration bearer only (same credential as the records route).
// State transitions: inbox|archived --trash--> trashed --restore--> inbox,
// trashed --purge--> purged (terminal), empty-trash purges every trashed id.
const INBOX_STATE_ACTIONS = ["trash", "restore", "purge", "empty-trash"];
export async function handleAidenInboxState(req, res, ctx) {
  if (!auth(req)) return send(res, 401, { ok: false, error: "unauthorized" });
  if (req.method === "GET") {
    const state = await readState(ctx);
    const trashed = {};
    const purged = [];
    for (const [id, entry] of Object.entries(state)) {
      if (entry?.status === "trashed") trashed[id] = { deletedAt: entry.deletedAt || entry.updatedAt || null };
      else if (entry?.status === "purged") purged.push(id);
    }
    return send(res, 200, { ok: true, trashed, purged });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method_not_allowed" });
  let input;
  try { input = await readBody(req); }
  catch { return send(res, 400, { ok: false, error: "invalid_input" }); }
  if (!input || typeof input !== "object" || Array.isArray(input) || !INBOX_STATE_ACTIONS.includes(input.action))
    return send(res, 400, { ok: false, error: "invalid_action" });
  if (input.action === "empty-trash") {
    if (input.confirm !== true) return send(res, 400, { ok: false, error: "confirmation_required" });
    const purged = await enqueueStateChange(async () => {
      const state = await readState(ctx);
      const ids = Object.keys(state).filter(id => state[id]?.status === "trashed");
      if (!ids.length) return [];
      const now = new Date().toISOString();
      for (const id of ids) state[id] = { status: "purged", updatedAt: now };
      await writeStateAtomic(ctx, state);
      return ids;
    });
    return send(res, 200, { ok: true, purged });
  }
  let ids;
  if (Array.isArray(input.ids)) ids = input.ids;
  else if (typeof input.id === "string") ids = [input.id];
  else return send(res, 400, { ok: false, error: "invalid_input" });
  if (!ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 160))
    return send(res, 400, { ok: false, error: "invalid_input" });
  let raw = "";
  try { raw = await readFile(target(ctx), "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const known = new Set(raw.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line).id; } catch { return null; } }).filter(Boolean));
  const results = await enqueueStateChange(async () => {
    const state = await readState(ctx);
    const now = new Date().toISOString();
    const out = [];
    let dirty = false;
    for (const id of ids) {
      const current = state[id]?.status || "inbox";
      if (!known.has(id)) { out.push({ id, ok: false, error: "not_found" }); continue; }
      if (current === "purged") { out.push({ id, ok: false, error: "purged" }); continue; }
      if (current === "deleted") { out.push({ id, ok: false, error: "deleted" }); continue; }
      if (input.action === "trash") {
        if (current === "trashed") { out.push({ id, ok: false, error: "already_trashed" }); continue; }
        state[id] = { status: "trashed", deletedAt: now, updatedAt: now };
        dirty = true;
        out.push({ id, ok: true, status: "trashed" });
      } else if (input.action === "restore") {
        if (current !== "trashed") { out.push({ id, ok: false, error: "not_trashed" }); continue; }
        state[id] = { status: "inbox", updatedAt: now };
        dirty = true;
        out.push({ id, ok: true, status: "inbox" });
      } else {
        if (current !== "trashed") { out.push({ id, ok: false, error: "not_trashed" }); continue; }
        state[id] = { status: "purged", updatedAt: now };
        dirty = true;
        out.push({ id, ok: true, status: "purged" });
      }
    }
    if (dirty) await writeStateAtomic(ctx, state);
    return out;
  });
  return send(res, 200, { ok: true, results });
}
export async function handleAidenCallIntegration(req, res, ctx) {
  if (!auth(req) && !(["GET","PATCH"].includes(req.method) && (req.operatorAuth || req.pipelineSession || req.aidenInboxAuth))) return send(res, 401, { ok: false, error: "unauthorized" });
  if(req.method==="PATCH") {
    if(!(req.operatorAuth||req.pipelineSession||req.aidenInboxAuth)) return send(res,403,{ok:false,error:"forbidden"});
    let input;try{input=await readBody(req)}catch{return send(res,400,{ok:false,error:"invalid_input"})}
    if(!input || typeof input.id!=="string" || input.id.length>160 || !input.id ||
      !["archive","restore","delete"].includes(input.action))return send(res,400,{ok:false,error:"invalid_action"});
    let raw="";try{raw=await readFile(target(ctx),"utf8")}catch(e){if(e.code!=="ENOENT")throw e}
    const found=raw.split(/\r?\n/).some(line=>{try{return JSON.parse(line).id===input.id}catch{return false}});
    if(!found)return send(res,404,{ok:false,error:"not_found"});
    const result=await updateState(ctx,input.id,input.action);
    return send(res,result.ok?200:409,result);
  }
  if (req.method === "POST") {
    let record;
    try { record = await readBody(req); }
    catch { return send(res, 400, { ok: false, error: "invalid_report" }); }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" ||
        record.id.length > 160 || !record.id || typeof record.message !== "string") {
      return send(res, 400, { ok: false, error: "invalid_report" });
    }
    const file = target(ctx);
    await mkdir(dirname(file), { recursive: true });
    // Retries are idempotent: suppress duplicates keyed by the Vapi call ID.
    let previous = "";
    try { previous = await readFile(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!previous.split("\n").some(line => {
      if (!line) return false;
      try { return JSON.parse(line).id === record.id; } catch { return false; }
    })) await appendFile(file, JSON.stringify(record) + "\n", "utf8");
    return send(res, 200, { ok: true, id: record.id });
  }
  if (req.method === "GET") {
    const view = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("view");
    if (view !== null && view !== "inbox" && view !== "trash")
      return send(res, 400, { ok: false, error: "invalid_view" });
    let raw = "";
    try { raw = await readFile(target(ctx), "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    const states=await readState(ctx);
    const records = raw.split(/\r?\n/).filter(Boolean).slice(-50).reverse().map(line => {const x=JSON.parse(line);const status=states[x.id]?.status||"inbox";const annotated={...x,inboxStatus:status};if(view==="trash"&&status==="trashed")annotated.deletedAt=states[x.id]?.deletedAt||null;return annotated;}).filter(x=>view==="trash"?x.inboxStatus==="trashed":view==="inbox"?!["deleted","trashed","purged"].includes(x.inboxStatus):x.inboxStatus!=="deleted");
    return send(res, 200, { ok: true, messages: records });
  }
  return send(res, 405, { ok: false, error: "method_not_allowed" });
}
