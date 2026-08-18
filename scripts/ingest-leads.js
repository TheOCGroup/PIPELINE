import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// 1. Run database backup first
console.log("Starting backup step...");
try {
  execSync("npm run backup", { stdio: "inherit" });
  console.log("Database backup completed successfully.");
} catch (err) {
  console.error("WARNING: Backup step failed, proceeding anyway:", err.message);
}

// Helper to parse simple local .env
function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, "utf8");
  const config = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      const k = trimmed.substring(0, idx).trim();
      const v = trimmed.substring(idx + 1).trim();
      config[k] = v;
    }
  }
  return config;
}

const env = loadLocalEnv();
const port = env.PIPELINE_PORT || 8090;
const secret = env.PIPELINE_PIPER_INTAKE_SECRET || "";

if (!secret) {
  console.error("FATAL ERROR: PIPELINE_PIPER_INTAKE_SECRET is not configured in .env!");
  process.exit(1);
}

const dealFinderDbPath = "C:\\Users\\Genaro\\.gemini\\antigravity\\scratch\\deal-finder\\data\\db.json";

if (!fs.existsSync(dealFinderDbPath)) {
  console.error(`FATAL ERROR: Deal Finder database not found at ${dealFinderDbPath}`);
  process.exit(1);
}

console.log("Reading Deal Finder database...");
const dealFinderDb = JSON.parse(fs.readFileSync(dealFinderDbPath, "utf8"));
const properties = dealFinderDb.properties || [];

console.log(`Inspecting ${properties.length} candidate record(s) from Deal Finder...`);

const report = {
  candidates: properties.length,
  productionQualified: 0,
  ingested: 0,
  rejectedFixtureTest: 0,
  duplicates: 0,
  details: []
};

// Check if each record is a real production lead rather than dummy/fixture
const qualifiedLeads = [];
for (const p of properties) {
  // A real lead must have a valid street address in Wichita (not sampleton, not placeholder, not blank)
  const isDemoOrPlaceholder = 
    !p.address || 
    p.address.toLowerCase().includes("placeholder") || 
    p.address.toLowerCase().includes("sample") || 
    p.address.toLowerCase().includes("synthetic") ||
    (p.ownerDossier && p.ownerDossier.name && p.ownerDossier.name.toLowerCase().includes("fixture"));

  if (isDemoOrPlaceholder) {
    report.rejectedFixtureTest++;
    console.log(`Rejected fixture/test lead: ID=${p.id}, Address="${p.address}"`);
    continue;
  }

  report.productionQualified++;
  qualifiedLeads.push(p);
}

console.log(`Found ${qualifiedLeads.length} production-qualified lead(s). Starting ingestion...`);

async function runIngestion() {
  for (const p of qualifiedLeads) {
    const fullAddress = `${p.address}, ${p.city || "Wichita"}, ${p.state || "KS"} ${p.zip || ""}`.trim();
    
    // Construct payload following the corrected intake contract
    const payload = {
      address: fullAddress,
      apn: p.sourceRecordId || null, // store APN as Deal Finder source record ID/APN
      askingPrice: p.askingPrice || null,
      arv: p.estimatedArv || null,
      rehab: p.estimatedRepairs || null,
      sellerName: p.ownerDossier?.name || null,
      phone: p.ownerDossier?.phone || null,
      email: p.ownerDossier?.email || null,
      sourceRecordId: p.id, // preserve actual Deal Finder record ID
      sourceMessageId: null, // do not overload source_message_id with APN
      sourceTimestamp: p.lastUpdated || new Date().toISOString(), // preserve original source timestamp
      classification: "unknown", // do not auto-classify as investment_rehab
      classificationReason: "No explicit Deal Finder classification supplied at intake"
    };

    console.log(`\nPosting lead: ${p.id} (${fullAddress})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/integrations/deal-findr/intake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (response.status === 200 || response.status === 201) {
        if (data.duplicate) {
          report.duplicates++;
          console.log(`-> Reconciled duplicate lead: ${data.opportunityId}`);
          report.details.push({
            id: p.id,
            address: fullAddress,
            status: "DUPLICATE_RECONCILED",
            oppId: data.opportunityId
          });
        } else {
          report.ingested++;
          console.log(`-> Ingested new opportunity: ID=${data.opportunityId}, Code=${data.opportunityCode}`);
          report.details.push({
            id: p.id,
            address: fullAddress,
            status: "INGESTED",
            oppId: data.opportunityId
          });
        }
      } else {
        console.error(`-> Error: Status ${response.status}, message: ${data.error || JSON.stringify(data)}`);
        report.details.push({
          id: p.id,
          address: fullAddress,
          status: `FAILED: ${data.error}`
        });
      }
    } catch (err) {
      console.error(`-> Fetch failed for ${p.id}:`, err.message);
      report.details.push({
        id: p.id,
        address: fullAddress,
        status: `FETCH_FAILED: ${err.message}`
      });
    }
  }

  // Generate final console audit report
  console.log("\n==============================================");
  console.log("             INGESTION FINAL REPORT           ");
  console.log("==============================================");
  console.log(`Candidates Inspected:      ${report.candidates}`);
  console.log(`Production-Qualified:      ${report.productionQualified}`);
  console.log(`Ingested (New):            ${report.ingested}`);
  console.log(`Duplicates Reconciled:     ${report.duplicates}`);
  console.log(`Rejected Fixtures/Test:    ${report.rejectedFixtureTest}`);
  console.log("==============================================\n");
}

runIngestion();
