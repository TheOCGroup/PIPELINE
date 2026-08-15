function getPath(value, path) {
  if (!path) return value;
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function first(value, paths) {
  for (const path of paths) {
    const found = getPath(value, path);
    if (found !== undefined && found !== null && found !== "") return found;
  }
  return null;
}

function addressFrom(value) {
  const direct = first(value, ["address", "propertyAddress", "streetAddress", "location.address"]);
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    return [direct.streetAddress, direct.addressLocality, direct.addressRegion, direct.postalCode].filter(Boolean).join(", ");
  }
  return null;
}

function mappedListing(value, source, index) {
  const map = source.configuration?.fieldMap || {};
  const custom = (field, defaults) => map[field] ? getPath(value, map[field]) : first(value, defaults);
  return {
    externalId: custom("externalId", ["id", "externalId", "listingId", "mlsId", "identifier"]) || `${source.id}:${index}`,
    address: map.address ? getPath(value, map.address) : addressFrom(value),
    askingPrice: custom("askingPrice", ["askingPrice", "price", "listPrice", "offers.price"]),
    arv: custom("arv", ["arv", "afterRepairValue"]),
    rehab: custom("rehab", ["rehab", "repairs", "estimatedRepairs"]),
    apn: custom("apn", ["apn", "parcelId", "parcelNumber"]),
    sellerName: custom("sellerName", ["sellerName", "owner.name"]),
    phone: custom("phone", ["phone", "owner.phone"]),
    email: custom("email", ["email", "owner.email"]),
    description: custom("description", ["description", "remarks", "summary"]),
    propertyCondition: custom("propertyCondition", ["propertyCondition", "condition"]),
    sourceUrl: custom("sourceUrl", ["url", "sourceUrl", "@id"]),
    discoveredAt: custom("discoveredAt", ["dateModified", "datePosted", "updatedAt", "createdAt"]),
    raw: value,
  };
}

function parseJson(text, source) {
  const payload = JSON.parse(text);
  const configured = getPath(payload, source.configuration?.itemsPath);
  const values = Array.isArray(configured) ? configured
    : Array.isArray(payload) ? payload
      : ["items", "results", "properties", "listings", "data"].map((key) => payload?.[key]).find(Array.isArray) || [];
  return values.map((value, index) => mappedListing(value, source, index)).filter((item) => item.address);
}

function parseJsonLd(text, source) {
  const scripts = [...text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const values = [];
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : parsed?.["@graph"] || [parsed];
      for (const candidate of candidates) {
        if (candidate && (candidate.address || candidate.location?.address)) values.push(candidate);
      }
    } catch { /* malformed third-party JSON-LD is skipped */ }
  }
  return values.map((value, index) => mappedListing(value, source, index)).filter((item) => item.address);
}

const entity = (value) => String(value || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();

function tag(xml, name) {
  return entity(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]);
}

function parseRss(text, source) {
  const entries = [...text.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].map((match) => match[1]);
  return entries.map((entry, index) => mappedListing({
    id: tag(entry, "guid") || tag(entry, "id") || `${source.id}:${index}`,
    address: tag(entry, "address") || tag(entry, "title"),
    description: tag(entry, "description") || tag(entry, "summary") || tag(entry, "content"),
    url: tag(entry, "link") || entry.match(/<link[^>]+href=["']([^"']+)/i)?.[1],
    dateModified: tag(entry, "pubDate") || tag(entry, "updated"),
    price: tag(entry, "price"),
  }, source, index)).filter((item) => item.address);
}

export function parsePiperSource(text, source) {
  if (source.sourceFormat === "json") return parseJson(text, source);
  if (source.sourceFormat === "jsonld") return parseJsonLd(text, source);
  if (source.sourceFormat === "rss") return parseRss(text, source);
  throw new Error(`unsupported_source_format:${source.sourceFormat}`);
}
