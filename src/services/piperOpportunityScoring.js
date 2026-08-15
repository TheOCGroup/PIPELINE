const DISTRESS_TERMS = [
  "as-is", "as is", "cash only", "fixer", "investor special", "estate",
  "foreclosure", "vacant", "fire damage", "needs work", "motivated seller",
  "foundation", "code violation", "auction", "probate"
];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function scorePiperOpportunity(listing) {
  let score = 20;
  const reasons = [];
  const askingPrice = number(listing.askingPrice);
  const arv = number(listing.arv);
  const rehab = number(listing.rehab);
  const text = `${listing.description || ""} ${listing.propertyCondition || ""}`.toLowerCase();

  const matchedTerms = DISTRESS_TERMS.filter((term) => text.includes(term));
  if (matchedTerms.length) {
    const points = Math.min(24, matchedTerms.length * 6);
    score += points;
    reasons.push({ signal: "distress_language", points, detail: matchedTerms.slice(0, 4) });
  }

  if (askingPrice !== null && arv !== null && arv > 0) {
    const priceRatio = askingPrice / arv;
    if (priceRatio <= 0.55) {
      score += 30;
      reasons.push({ signal: "deep_discount", points: 30, detail: priceRatio });
    } else if (priceRatio <= 0.7) {
      score += 20;
      reasons.push({ signal: "discount", points: 20, detail: priceRatio });
    } else if (priceRatio <= 0.82) {
      score += 8;
      reasons.push({ signal: "moderate_discount", points: 8, detail: priceRatio });
    } else {
      score -= 10;
      reasons.push({ signal: "thin_discount", points: -10, detail: priceRatio });
    }
  }

  if (askingPrice !== null && arv !== null && rehab !== null) {
    const estimatedSpread = arv * 0.7 - rehab - askingPrice;
    if (estimatedSpread >= 30000) {
      score += 18;
      reasons.push({ signal: "mao_spread", points: 18, detail: estimatedSpread });
    } else if (estimatedSpread < 0) {
      score -= 18;
      reasons.push({ signal: "negative_mao_spread", points: -18, detail: estimatedSpread });
    }
  }

  const completeness = [listing.address, askingPrice, arv, rehab, listing.sourceUrl].filter((value) => value !== null && value !== undefined && value !== "").length;
  if (completeness >= 4) {
    score += 8;
    reasons.push({ signal: "data_completeness", points: 8, detail: completeness });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

export function recommendationForScore(score) {
  if (score >= 80) return { type: "review_now", priority: "critical" };
  if (score >= 65) return { type: "contact_seller", priority: "high" };
  if (score >= 45) return { type: "request_underwriting", priority: "medium" };
  if (score >= 25) return { type: "monitor", priority: "low" };
  return { type: "reject", priority: "low" };
}
