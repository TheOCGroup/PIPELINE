import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
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
async function readState(ctx) {
  try { return JSON.parse(await readFile(stateTarget(ctx), "utf8")); }
  catch(e) { if(e.code==="ENOENT") return {}; throw e; }
}
async function updateState(ctx,id,action) {
  const change=stateWriteQueue.catch(()=>{}).then(async()=>{
    const state=await readState(ctx);
    if(state[id]?.status==="deleted" && action!=="delete") return {ok:false,error:"already_deleted"};
    state[id]={status:action==="archive"?"archived":action==="restore"?"inbox":"deleted",updatedAt:new Date().toISOString()};
    const file=stateTarget(ctx);await mkdir(dirname(file),{recursive:true});
    const staging=file+".tmp";await writeFile(staging,JSON.stringify(state),"utf8");await rename(staging,file);
    return {ok:true,id,status:state[id].status};
  });
  stateWriteQueue=change;return change;
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
    let raw = "";
    try { raw = await readFile(target(ctx), "utf8"); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    const states=await readState(ctx);
    const records = raw.split(/\r?\n/).filter(Boolean).slice(-50).reverse().map(line => {const x=JSON.parse(line);return {...x,inboxStatus:states[x.id]?.status||"inbox"};}).filter(x=>x.inboxStatus!=="deleted");
    return send(res, 200, { ok: true, messages: records });
  }
  return send(res, 405, { ok: false, error: "method_not_allowed" });
}
