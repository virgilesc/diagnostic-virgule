// ============================================================
//  pagespeed.js — Netlify Function (Version 2.2 — Optimized)
//  Diagnostic marketing & conversion (TPE / PME)
//  Workflow : URL → PageSpeed API → scoring business → JSON
// ============================================================


// ── Constantes ───────────────────────────────────────────────
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const API_KEY = process.env.PAGESPEED_API_KEY;
// Netlify Free/Starter = 26s max (limite plateforme, non configurable).
// On cible 22s — marge pour le runtime Netlify + réseau.
const TIMEOUT_MS = 22000;

// Champs PSI retournés — limiter réduit fortement le temps de réponse Google
// sur les sites lourds (évite de télécharger screenshots + audits complets inutiles).
const PSI_FIELDS = [
  "lighthouseResult/categories",
  "lighthouseResult/audits/first-contentful-paint",
  "lighthouseResult/audits/largest-contentful-paint",
  "lighthouseResult/audits/total-blocking-time",
  "lighthouseResult/audits/cumulative-layout-shift",
  "lighthouseResult/audits/speed-index",
  "lighthouseResult/audits/interactive",
  "lighthouseResult/audits/is-on-https",
  "lighthouseResult/audits/viewport",
  "lighthouseResult/audits/uses-optimized-images",
  "lighthouseResult/audits/render-blocking-resources",
  "lighthouseResult/audits/font-display",
  "lighthouseResult/audits/aria-required-attr",
  "lighthouseResult/audits/tap-targets",
  "lighthouseResult/audits/legacy-javascript",
  "lighthouseResult/audits/unused-css-rules",
  "lighthouseResult/audits/unused-javascript",
  "lighthouseResult/audits/document-title",
  "lighthouseResult/audits/meta-description",
  "lighthouseResult/audits/hreflang",
  "lighthouseResult/audits/canonical",
  "lighthouseResult/audits/link-text",
  "lighthouseResult/audits/robots-txt",
  "lighthouseResult/audits/full-page-screenshot",
  "lighthouseResult/audits/final-screenshot",
  "loadingExperience/metrics",
].join(",");

// ── Codes d'erreur machine (utilisés par le frontend) ────────
const ERROR_CODES = {
  INVALID_URL:        "INVALID_URL",        // Format d'URL incorrect
  URL_UNREACHABLE:    "URL_UNREACHABLE",    // Site inaccessible / domaine inexistant
  ANALYSIS_TIMEOUT:   "ANALYSIS_TIMEOUT",  // Lighthouse n'a pas répondu à temps
  ANALYSIS_FAILED:    "ANALYSIS_FAILED",   // Erreur PSI non classifiée
  CONFIG_ERROR:       "CONFIG_ERROR",      // Problème de configuration serveur
};

// ── Classe d'erreur structurée ────────────────────────────────
class AppError extends Error {
  constructor(code, message, httpStatus = 500) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ── Validation d'URL côté serveur (avant tout appel API) ─────
function validateUrl(raw) {
  if (!raw || typeof raw !== "string") {
    throw new AppError(ERROR_CODES.INVALID_URL, "URL manquante.", 400);
  }

  const trimmed = raw.trim();

  // Doit commencer par http:// ou https://
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new AppError(
      ERROR_CODES.INVALID_URL,
      "L'URL doit commencer par https:// ou http://",
      400
    );
  }

  // Validation via le constructeur URL natif
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(ERROR_CODES.INVALID_URL, "Format d'URL invalide.", 400);
  }

  // Le hostname doit contenir au moins un point (exclut "localhost", etc.)
  if (!parsed.hostname.includes(".")) {
    throw new AppError(ERROR_CODES.INVALID_URL, "Nom de domaine invalide.", 400);
  }

  return trimmed;
}

// ============================================================
//  HANDLER PRINCIPAL
// ============================================================
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    if (!API_KEY) {
      console.error("❌ PAGESPEED_API_KEY manquante!");
      throw new AppError(ERROR_CODES.CONFIG_ERROR, "PAGESPEED_API_KEY non définie.", 500);
    }

    const body = JSON.parse(event.body || "{}");
    const { url: rawUrl, email } = body;

    // Validation et normalisation de l'URL — lève AppError si invalide
    const url = validateUrl(rawUrl);

    console.log(`📊 Analyse lancée pour: ${url}`);

    // ── 1. Appels PageSpeed ──────────────────────────────────
    // Mobile uniquement — le desktop a été supprimé car 2 appels parallèles
    // dépassaient les 26s de timeout Netlify sur les gros sites.
    // Mobile = >60% du trafic TPE/PME, les scores business restent pertinents.
    console.log("🔄 Appel PageSpeed API (mobile uniquement)...");
    const mobileRaw = await fetchPageSpeed(url, "mobile");
    const desktopRaw = mobileRaw; // Alias — desktop non analysé

    // ── 2. Extraction des métriques ──────────────────────────
    const mobile = extractMetrics(mobileRaw);
    const desktop = mobile; // Même données, écart mobile/desktop = 0

    // ── 3. Scores Google ────────────────────────────────────
    const googleScores = buildGoogleScores(mobile);

    // ── 4. Scores business ──────────────────────────────────
    const businessScores = buildBusinessScores(mobile, desktop, googleScores);

    // ── 5. Points critiques ────────────────────────────────
    const criticalPoints = buildCriticalPoints(mobile, googleScores, businessScores);

    // ── 6. Synthèse ────────────────────────────────────────
    const summary = buildSummary(googleScores, businessScores, criticalPoints);

    // ── 7. Screenshots ─────────────────────────────────────
    const screenshots = extractScreenshots(mobileRaw, desktopRaw);

    // ── 8. Payload final ───────────────────────────────────
    const report = {
      meta: {
        url,
        email: email || null,
        analyzedAt: new Date().toISOString(),
        version: "2.2",
      },
      summary,
      criticalPoints,
      businessScores,
      googleScores,
      screenshots,
      rawMetrics: {
        mobile: mobile.metrics,
        desktop: desktop.metrics,
      },
    };

    console.log(`✅ Rapport généré avec succès`);
    return respond(200, headers, report);
  } catch (err) {
    console.error("❌ pagespeed.js error:", err.code ?? "?", "—", err.message);

    // Messages utilisateur par code d'erreur
    const USER_MESSAGES = {
      [ERROR_CODES.INVALID_URL]:
        "L'URL saisie est invalide. Vérifiez qu'elle commence par https:// et contient un nom de domaine correct.",
      [ERROR_CODES.URL_UNREACHABLE]:
        "Ce site est inaccessible. Il est peut-être hors ligne, protégé, ou le domaine n'existe pas.",
      [ERROR_CODES.ANALYSIS_TIMEOUT]:
        "L'analyse a pris trop de temps. Ce site est trop lourd pour notre outil. Essayez l'URL de la page d'accueil ou réessayez dans quelques instants.",
      [ERROR_CODES.ANALYSIS_FAILED]:
        "L'analyse a échoué. Vérifiez que le site est accessible publiquement et réessayez.",
      [ERROR_CODES.CONFIG_ERROR]:
        "Erreur de configuration serveur. Contactez le support.",
    };

    const code = err.code ?? ERROR_CODES.ANALYSIS_FAILED;
    const httpStatus = err.httpStatus ?? 500;
    const retryable = [ERROR_CODES.ANALYSIS_TIMEOUT, ERROR_CODES.ANALYSIS_FAILED].includes(code);

    return respond(httpStatus, headers, {
      error: USER_MESSAGES[code] ?? "Une erreur inattendue s'est produite.",
      code,
      retryable,
      detail: err.message, // utile pour le debug, à masquer en prod si besoin
    });
  }
};

// ============================================================
//  APPEL API PAGESPEED — classification d'erreurs + retry
// ============================================================
async function fetchPageSpeed(url, strategy, attempt = 1) {
  const MAX_ATTEMPTS = 2;

  const params = new URLSearchParams();
  params.append('url', url);
  params.append('strategy', strategy);
  params.append('locale', 'fr');
  // Performance uniquement — accessibility/best-practices/seo ont des audits
  // lourds qui rallongent PSI de ~5-8s sur les gros sites.
  // Les scores accessibility, bestPractices, seo restent disponibles dans
  // lighthouseResult/categories même sans passer les catégories en paramètre.
  params.append('category', 'performance');
  params.append('fields', PSI_FIELDS);
  params.append('key', API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log(`⏱️ Appel PageSpeed (${strategy}) [tentative ${attempt}/${MAX_ATTEMPTS}]...`);
    const res = await fetch(`${PSI_ENDPOINT}?${params}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`❌ HTTP ${res.status} (${strategy})`);

      // Retry sur erreurs transitoires Google (500/503)
      if ((res.status === 500 || res.status === 503) && attempt < MAX_ATTEMPTS) {
        console.log(`🔁 Retry dans 1s...`);
        await new Promise(r => setTimeout(r, 1000));
        return fetchPageSpeed(url, strategy, attempt + 1);
      }

      // Lire le corps pour distinguer URL invalide vs erreur serveur
      let psiError = null;
      try { psiError = await res.json(); } catch { /* corps non-JSON */ }

      const psiStatus = psiError?.error?.status ?? "";
      const psiMessage = psiError?.error?.message ?? "";
      console.error(`PSI error status: ${psiStatus} — ${psiMessage}`);

      // 400 INVALID_ARGUMENT  = URL inconnue de Google / domaine inexistant
      // 400 NOT_FOUND         = site inaccessible (down, bloqué, etc.)
      if (res.status === 400) {
        if (psiStatus === "INVALID_ARGUMENT") {
          throw new AppError(
            ERROR_CODES.INVALID_URL,
            `URL non reconnue par PageSpeed : ${psiMessage}`,
            400
          );
        }
        if (psiStatus === "NOT_FOUND" || psiMessage.toLowerCase().includes("not found")) {
          throw new AppError(
            ERROR_CODES.URL_UNREACHABLE,
            `Site inaccessible selon PageSpeed : ${psiMessage}`,
            422
          );
        }
        // Autre 400 : traiter comme URL invalide par défaut
        throw new AppError(
          ERROR_CODES.INVALID_URL,
          `Requête rejetée par PageSpeed (400) : ${psiMessage}`,
          400
        );
      }

      // Autres codes non-retry → échec d'analyse générique
      throw new AppError(
        ERROR_CODES.ANALYSIS_FAILED,
        `PageSpeed API (${strategy}): HTTP ${res.status}`,
        502
      );
    }

    const json = await res.json();

    // Lighthouse peut répondre 200 mais sans résultat (site protégé, redirect infini…)
    if (!json.lighthouseResult) {
      const runError = json?.error?.message ?? "lighthouseResult absent";
      console.error(`❌ Pas de lighthouseResult : ${runError}`);
      throw new AppError(
        ERROR_CODES.URL_UNREACHABLE,
        `PageSpeed n'a pas pu analyser ce site : ${runError}`,
        422
      );
    }

    console.log(`✅ PageSpeed (${strategy}) OK`);
    return json;

  } catch (err) {
    clearTimeout(timeout);

    // AbortError = notre timeout a expiré
    if (err.name === "AbortError") {
      console.error(`⏰ TIMEOUT ${strategy} après ${TIMEOUT_MS / 1000}s`);
      throw new AppError(
        ERROR_CODES.ANALYSIS_TIMEOUT,
        `Analyse trop longue (>${TIMEOUT_MS / 1000}s) pour ${strategy}`,
        504
      );
    }

    // Rethrow les AppError telles quelles (déjà classifiées)
    if (err instanceof AppError) throw err;

    // Erreur réseau inattendue
    console.error(`❌ Erreur réseau ${strategy}:`, err.message);
    throw new AppError(
      ERROR_CODES.ANALYSIS_FAILED,
      `Erreur réseau : ${err.message}`,
      502
    );
  }
}

// ============================================================
//  EXTRACTION DES MÉTRIQUES
// ============================================================
function extractMetrics(raw) {
  const cats = raw?.lighthouseResult?.categories || {};
  const audits = raw?.lighthouseResult?.audits || {};
  const loading = raw?.loadingExperience?.metrics || {};

  const numericAudit = (id) => audits[id]?.numericValue ?? null;
  const scoreAudit = (id) => { const s = audits[id]?.score; return s !== null && s !== undefined ? Math.round(s * 100) : null; };
  const displayValue = (id) => audits[id]?.displayValue ?? null;

  return {
    scores: {
      performance: Math.round((cats.performance?.score ?? 0) * 100),
      accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
      bestPractices: Math.round((cats["best-practices"]?.score ?? 0) * 100),
      seo: Math.round((cats.seo?.score ?? 0) * 100),
    },
    metrics: {
      fcp: numericAudit("first-contentful-paint"),
      lcp: numericAudit("largest-contentful-paint"),
      tbt: numericAudit("total-blocking-time"),
      cls: numericAudit("cumulative-layout-shift"),
      speedIndex: numericAudit("speed-index"),
      tti: numericAudit("interactive"),
      fid: loading?.FIRST_INPUT_DELAY_MS?.percentile ?? null,
      fcpDisplay: displayValue("first-contentful-paint"),
      lcpDisplay: displayValue("largest-contentful-paint"),
      tbtDisplay: displayValue("total-blocking-time"),
      clsDisplay: displayValue("cumulative-layout-shift"),
      speedIndexDisplay: displayValue("speed-index"),
      isHttps: scoreAudit("is-on-https") === 100,
      hasViewport: scoreAudit("viewport") === 100,
      imageOptimized: scoreAudit("uses-optimized-images"),
      renderBlocking: scoreAudit("render-blocking-resources"),
      fontDisplay: scoreAudit("font-display"),
      ariaLabels: scoreAudit("aria-required-attr"),
      tapTargets: scoreAudit("tap-targets"),
      legacyJavascript: scoreAudit("legacy-javascript"),
      unusedCss: scoreAudit("unused-css-rules"),
      unusedJs: scoreAudit("unused-javascript"),
      documentTitle: scoreAudit("document-title"),
      metaDescription: scoreAudit("meta-description"),
      hreflang: scoreAudit("hreflang"),
      canonicalTag: scoreAudit("canonical"),
      linkText: scoreAudit("link-text"),
      robots: scoreAudit("robots-txt"),
    },
  };
}

// ============================================================
//  SCORES GOOGLE
// ============================================================
function buildGoogleScores(mobile) {
  const { performance, accessibility, bestPractices, seo } = mobile.scores;
  return {
    performance: { score: performance, label: label(performance), color: color(performance) },
    accessibility: { score: accessibility, label: label(accessibility), color: color(accessibility) },
    bestPractices: { score: bestPractices, label: label(bestPractices), color: color(bestPractices) },
    seo: { score: seo, label: label(seo), color: color(seo) },
  };
}

// ============================================================
//  SCORES BUSINESS
// ============================================================
function buildBusinessScores(mobile, desktop, googleScores) {
  const m = mobile.metrics;
  const d = desktop.metrics;

  const clsScore = clsToScore(m.cls);
  const mobileScore = mobileReadinessScore(m);
  const visualSpeedScore = speedToScore(m.fcp, 2500, 4500);
  const mobileDesktopGap = Math.abs((mobile.scores.performance || 0) - (desktop.scores.performance || 0));
  const consistencyPenalty = mobileDesktopGap > 30 ? -10 : mobileDesktopGap > 15 ? -5 : 0;

  const designScore = clamp((clsScore * 0.4 + mobileScore * 0.3 + visualSpeedScore * 0.3) + consistencyPenalty, 0, 100);

  const lcpScore = speedToScore(m.lcp, 2500, 4500);
  const tbtScore = tbtToScore(m.tbt);
  const perfScore = googleScores.performance.score;

  const conversionScore = clamp(lcpScore * 0.45 + tbtScore * 0.25 + perfScore * 0.3, 0, 100);

  const httpsScore = m.isHttps ? 100 : 0;
  const seoScore = googleScores.seo.score;
  const a11yScore = googleScores.accessibility.score;
  const bpScore = googleScores.bestPractices.score;

  const credibilityScore = clamp(httpsScore * 0.35 + seoScore * 0.25 + a11yScore * 0.2 + bpScore * 0.2, 0, 100);

  return {
    design: {
      score: Math.round(designScore),
      label: labelBusiness(designScore),
      headline: headlineDesign(designScore),
      impact: impactDesign(designScore),
      color: color(designScore),
    },
    conversion: {
      score: Math.round(conversionScore),
      label: labelBusiness(conversionScore),
      headline: headlineConversion(designScore),
      impact: impactConversion(conversionScore, m.lcp),
      color: color(conversionScore),
      lostVisitors: estimateLostVisitors(m.lcp),
    },
    credibility: {
      score: Math.round(credibilityScore),
      label: labelBusiness(credibilityScore),
      headline: headlineCredibility(credibilityScore),
      impact: impactCredibility(credibilityScore, m.isHttps),
      color: color(credibilityScore),
      isHttps: m.isHttps,
    },
  };
}

// ============================================================
//  POINTS CRITIQUES
// ============================================================
function buildCriticalPoints(mobile, googleScores, businessScores) {
  const points = [];
  const m = mobile.metrics;

  if (!m.isHttps) {
    points.push({
      severity: "critical",
      icon: "🔓",
      title: "HTTPS manquant",
      description: "85% des navigateurs affichent un avertissement.",
      actionable: "Activez HTTPS auprès de votre hébergeur.",
      impact: "Perte ~85% des visiteurs",
    });
  }

  if (m.lcp && m.lcp > 3500) {
    points.push({
      severity: "critical",
      icon: "⚡",
      title: "Votre site est trop lent",
      description: `Affichage en ${(m.lcp / 1000).toFixed(1)}s (idéal: <2.5s).`,
      actionable: "Optimisez images et réduisez JS bloquant.",
      impact: "Perte ~5-10% visiteurs",
    });
  }

  if (m.cls && m.cls > 0.1) {
    points.push({
      severity: "warning",
      icon: "📐",
      title: "Votre site se déplace",
      description: `Décalages visuels (CLS: ${m.cls.toFixed(2)}).`,
      actionable: "Définissez dimensions images/pubs.",
      impact: "Frustration utilisateur",
    });
  }

  if (m.tbt && m.tbt > 500) {
    points.push({
      severity: "warning",
      icon: "🖱️",
      title: "JavaScript bloquant",
      description: `Bloque ${m.tbt.toFixed(0)}ms.`,
      actionable: "Déprioritisez JS non-essentiel.",
      impact: "Site semble gelé",
    });
  }

  if (googleScores.performance.score < 50) {
    points.push({
      severity: "critical",
      icon: "📊",
      title: "Performance critique",
      description: `Score: ${googleScores.performance.score}/100.`,
      actionable: "Utilisez PageSpeed Insights.",
      impact: "Pénalisé par Google",
    });
  }

  if (googleScores.seo.score < 60) {
    points.push({
      severity: "warning",
      icon: "🔍",
      title: "SEO insuffisant",
      description: `Score: ${googleScores.seo.score}/100.`,
      actionable: "Vérifiez meta titles, descriptions.",
      impact: "Moins de trafic organique",
    });
  }

  return points.slice(0, 6);
}

// ============================================================
//  SYNTHÈSE
// ============================================================
function buildSummary(googleScores, businessScores, criticalPoints) {
  const criticals = criticalPoints.filter((p) => p.severity === "critical").length;
  const warnings = criticalPoints.filter((p) => p.severity === "warning").length;

  const globalScore = Math.round(
    businessScores.conversion.score * 0.35 +
    businessScores.credibility.score * 0.25 +
    businessScores.design.score * 0.20 +
    googleScores.seo.score * 0.20
  );

  const globalLabel = globalScore >= 80 ? "Bon" : globalScore >= 60 ? "Moyen" : "Faible";
  const globalColor = color(globalScore);

  let headline, subheadline, emotion;

  if (criticals >= 3) {
    emotion = "urgent";
    headline = "Votre site vous coûte des clients";
    subheadline = `${criticals} critiques. Chaque jour sans action, vous perdez.`;
  } else if (criticals >= 1) {
    emotion = "concern";
    headline = "Potentiel inexploité";
    subheadline = `${criticals} point critique freine vos conversions.`;
  } else if (warnings >= 2) {
    emotion = "opportunity";
    headline = "Ça peut faire bien mieux";
    subheadline = "Plusieurs optimisations pour améliorer.";
  } else {
    emotion = "positive";
    headline = "Bonne position";
    subheadline = "Quelques ajustements encore.";
  }

  return {
    globalScore,
    globalLabel,
    globalColor,
    emotion,
    headline,
    subheadline,
    criticalCount: criticals,
    warningCount: warnings,
    callToAction: "Discutons →",
  };
}

// ============================================================
//  SCREENSHOTS
// ============================================================
function extractScreenshots(mobileRaw, desktopRaw) {
  const getShot = (raw, id) => {
    const audit = raw?.lighthouseResult?.audits?.[id];
    if (!audit) return null;
    if (id === "full-page-screenshot") {
      return audit?.details?.screenshot?.data ?? null;
    }
    return audit?.details?.data ?? null;
  };

  return {
    mobile: getShot(mobileRaw, "full-page-screenshot") ?? getShot(mobileRaw, "final-screenshot"),
    desktop: getShot(desktopRaw, "full-page-screenshot") ?? getShot(desktopRaw, "final-screenshot"),
  };
}

// ============================================================
//  HELPERS
// ============================================================

function speedToScore(ms, goodThreshold, poorThreshold) {
  if (ms === null || ms === undefined) return 50;
  if (ms <= goodThreshold) return 100;
  if (ms >= poorThreshold) return 10;
  return Math.round(100 - ((ms - goodThreshold) / (poorThreshold - goodThreshold)) * 90);
}

function clsToScore(cls) {
  if (cls === null || cls === undefined) return 50;
  if (cls <= 0.05) return 100;
  if (cls >= 0.5) return 10;
  return Math.round(100 - (cls / 0.5) * 90);
}

function tbtToScore(tbt) {
  if (tbt === null || tbt === undefined) return 50;
  if (tbt <= 200) return 100;
  if (tbt >= 600) return 10;
  return Math.round(100 - ((tbt - 200) / 400) * 90);
}

function mobileReadinessScore(m) {
  let score = 60;
  if (m.hasViewport) score += 20;
  if ((m.tapTargets ?? 0) >= 90) score += 20;
  else if ((m.tapTargets ?? 0) >= 70) score += 10;
  return clamp(score, 0, 100);
}

function estimateLostVisitors(lcpMs) {
  if (lcpMs <= 3000) return null;
  const extraSeconds = (lcpMs - 3000) / 1000;
  const rate = Math.min(Math.round(extraSeconds * 20), 80);
  return `Jusqu'à ${rate}% abandonnent`;
}

function label(score) {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Bien";
  if (score >= 50) return "Moyen";
  return "Faible";
}

function labelBusiness(score) {
  if (score >= 80) return "Optimisé";
  if (score >= 60) return "Améliorable";
  if (score >= 40) return "Insuffisant";
  return "Critique";
}

function color(score) {
  if (score >= 80) return "green";
  if (score >= 60) return "orange";
  return "red";
}

function headlineDesign(score) {
  if (score >= 80) return "Expérience visuelle soignée";
  if (score >= 60) return "Design perfectible";
  return "Design nuit à crédibilité";
}

function headlineConversion(score) {
  if (score >= 80) return "Site fluide";
  if (score >= 60) return "Frictions ralentissent";
  return "Décourage l'action";
}

function headlineCredibility(score) {
  if (score >= 80) return "Fiable";
  if (score >= 60) return "Signaux manquants";
  return "Manque crédibilité";
}

function impactDesign(score) {
  if (score >= 80) return "Professionnalisme dès le 1er regard.";
  if (score >= 60) return "Incohérences visuelles détectées.";
  return "Design instable fait fuir visiteurs.";
}

function impactConversion(score, lcpMs) {
  const lcpSec = lcpMs ? (lcpMs / 1000).toFixed(1) : null;
  if (score >= 80) return "Rapide = conversion.";
  if (score >= 60) return lcpSec ? `${lcpSec}s = friction. Coûte ~7% conversions.` : "Friction réduit conversions.";
  return "Trop lent. Perte clients.";
}

function impactCredibility(score, isHttps) {
  if (!isHttps) return "Sans HTTPS, 85% quittent immédiatement.";
  if (score >= 80) return "Signaux de confiance OK.";
  if (score >= 60) return "Quelques éléments manquent.";
  return "Crédibilité insuffisante.";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function respond(statusCode, headers, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body, null, 0),
  };
}
